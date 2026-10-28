import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { loadConfig } from "./config.js"
import type { AdoptOutcome, ComposeEngine, DiffResult } from "./engine-client.js"
import { asTheEngineRefused, ensureEngine, enginePush, engineRequest } from "./engine-client.js"
import {
  isAdoptOutcome,
  isDatabaseStateJson,
  isDiffResult,
  isDoctorReport,
  isEnginePushResult,
  isMigrationList,
  isMigrationsAnswer,
  isSchemaRollbackResult,
} from "./engine-answers.js"
import type { EnginePushResult } from "./engine-push-output.js"
import type { DoctorReport } from "./commands/doctor.js"
import type { DatabaseStateJson } from "./pull-utils.js"
import { readJsonFileOrThrow } from "./json-file.js"
import { isShape, isString, optional, type Guard } from "@supatype/shared"
import type { SchemaSourcesPayload } from "./schema-sources.js"
import type { AppliedRenameRecord } from "./rename-journal.js"
import { pushAuditFields } from "./push-audit.js"
import { resolveHostDatabaseUrl } from "./host-database.js"
import { configuredServiceRoleKey, shellServiceRoleKey } from "./dev-api-keys.js"
import {
  pgSchema,
  resolveRuntimeProvider,
  schemaPathFromProject,
  serverBaseUrl,
  type SupatypeProjectConfig,
} from "./project-config.js"
import {
  getEnvironmentTarget,
  loadLocalEnvironment,
  loadProjectLink,
  resolveEnvironmentName,
  resolveEnvironmentToken,
  isBranchContext,
  type BranchContext,
  type LocalEnvironment,
  type ProjectLink,
} from "./link.js"
import {
  persistCloudSession,
  resolveCloudAccessToken,
  resolveCloudRefreshToken,
} from "./cloud-credentials.js"
import { TargetApiError, targetFetch, type TargetFetchOptions } from "./target-client.js"
import { CAPABILITIES_TTL_MS, capabilitiesCache, rememberCapabilities, type CapabilitiesCache } from "@supatype/shared"
import {
  adoptNeeds,
  assertSupported,
  engineCapabilities,
  identityColumnsNeed,
  parseCapabilities,
  REBASELINE_KEYS_NEED,
  type Capabilities,
  type FeatureNeed,
} from "./engine-ownership-gate.js"

export interface ResolveTargetFlags {
  env?: string | undefined
  direct?: boolean
  local?: boolean
  connection?: string | undefined
}

export type TargetMode = "cloud" | "self-host" | "local" | "direct"

export interface DeployTarget {
  mode: TargetMode
  environment: string
  projectRef: string
  apiBaseUrl: string
  apiPrefix: "/api/v1" | "/platform/v1"
  token?: string | undefined
  /** Cloud auth refresh token (mode === "cloud" only). */
  refreshToken?: string | undefined
  orgId?: string | undefined
  link: ProjectLink | null
  /** Project cwd: needed to persist refreshed cloud tokens. */
  cwd?: string
  /** Engine subprocess path when mode is direct or local without control plane. */
  databaseUrl?: string
  /**
   * The project's engine image, for a docker project with no `overrides.engine`: the engine runs
   * there rather than as the host binary, as push does.
   */
  compose?: ComposeEngine
}

export function loadLocalEnvironmentFile(cwd: string): LocalEnvironment | null {
  return loadLocalEnvironment(cwd)
}

export function loadBranchContext(cwd: string): BranchContext | null {
  const path = resolve(cwd, ".supatype/branch.json")
  if (!existsSync(path)) return null
  return readJsonFileOrThrow(path, isBranchContext, "a branch context")
}

function resolveBranchDefaults(cwd: string, configEnvDefault?: string): string | undefined {
  if (configEnvDefault) return configEnvDefault
  try {
    const config = loadConfig(cwd)
    const branchDefaults = config.environments?.branchDefaults
    if (!branchDefaults) return undefined
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8" }).trim()
    return branchDefaults[branch]
  } catch {
    return undefined
  }
}

/**
 * The project's database as a host process reaches it, for a target that runs the engine here.
 *
 * Never `.supatype/environment.json`'s URL: that one describes the docker `db` container, right
 * for a container and unresolvable from the host, which is how `supatype adopt` on a docker
 * project failed (supatype#85).
 */
function hostDatabaseUrl(cwd: string, config: SupatypeProjectConfig, connection: string | undefined): string {
  return resolveHostDatabaseUrl(cwd, config, { connection, allowDerived: true }).dsn
}

export function resolveTarget(cwd: string, flags: ResolveTargetFlags = {}): DeployTarget {
  const config = loadConfig(cwd)
  const projectRef = config.project?.name ?? config.project?.ref ?? "project"
  const branchCtx = loadBranchContext(cwd)

  if (branchCtx) {
    return {
      mode: "self-host",
      environment: `branch:${branchCtx.branchId}`,
      projectRef,
      apiBaseUrl: branchCtx.apiUrl.replace(/\/$/, ""),
      apiPrefix: "/platform/v1",
      token: branchCtx.token,
      link: loadProjectLink(cwd),
    }
  }

  if (flags.direct || flags.local) {
    return {
      mode: "direct",
      environment: "local",
      projectRef,
      apiBaseUrl: (serverBaseUrl(config) ?? "").replace(/\/$/, ""),
      apiPrefix: "/platform/v1",
      link: null,
      databaseUrl: hostDatabaseUrl(cwd, config, flags.connection),
    }
  }

  const link = loadProjectLink(cwd)
  const localEnv = loadLocalEnvironment(cwd)

  if (!link) {
    if (localEnv && resolveRuntimeProvider(config) === "docker") {
      return {
        mode: "local",
        environment: "local",
        projectRef: localEnv.projectRef,
        apiBaseUrl: localEnv.apiUrl.replace(/\/$/, ""),
        apiPrefix: "/platform/v1",
        token: shellServiceRoleKey(cwd),
        link: null,
        databaseUrl: hostDatabaseUrl(cwd, config, flags.connection),
      }
    }
    return {
      mode: "direct",
      environment: "local",
      projectRef,
      apiBaseUrl: (serverBaseUrl(config) ?? "").replace(/\/$/, ""),
      apiPrefix: "/platform/v1",
      link: null,
      databaseUrl: hostDatabaseUrl(cwd, config, flags.connection),
    }
  }

  const envName = resolveEnvironmentName(
    link,
    flags.env ?? resolveBranchDefaults(cwd, config.environments?.default),
  )
  const envTarget = getEnvironmentTarget(link, envName)
  if (!envTarget) {
    throw new Error(
      `Environment "${envName}" not linked. Run: supatype link --env ${envName} ... or supatype envs list`,
    )
  }

  const token =
    (link.kind === "cloud" ? resolveCloudAccessToken(link) : undefined) ??
    resolveEnvironmentToken(link, envTarget)
  if (!token) {
    throw new Error(
      link.kind === "cloud"
        ? `No cloud session for environment "${envName}". Run: supatype login`
        : `No token for environment "${envName}". Re-run supatype link --token ...`,
    )
  }

  if (link.kind === "cloud") {
    const refreshToken = resolveCloudRefreshToken(link)
    return {
      mode: "cloud",
      environment: envName,
      projectRef: link.projectRef,
      apiBaseUrl: (link.cloudApiUrl ?? envTarget.apiUrl).replace(/\/$/, ""),
      apiPrefix: "/api/v1",
      token,
      link,
      cwd,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      ...(link.orgId !== undefined ? { orgId: link.orgId } : {}),
    }
  }

  return {
    mode: link.kind === "local" ? "local" : "self-host",
    environment: envName,
    projectRef: link.projectRef,
    apiBaseUrl: envTarget.apiUrl.replace(/\/$/, ""),
    apiPrefix: "/platform/v1",
    token,
    link,
    cwd,
  }
}

function cloudAuthRefresh(target: DeployTarget): TargetFetchOptions["authRefresh"] | undefined {
  if (target.mode !== "cloud" || !target.refreshToken || !target.cwd) return undefined
  const cloudApiUrl = (target.link?.cloudApiUrl ?? target.apiBaseUrl).replace(/\/$/, "")
  const cwd = target.cwd
  return {
    cloudApiUrl,
    refreshToken: target.refreshToken,
    onRefreshed: ({ accessToken, refreshToken }) => {
      persistCloudSession(cwd, {
        apiUrl: cloudApiUrl,
        accessToken,
        ...(refreshToken !== undefined ? { refreshToken } : {}),
      })
      target.token = accessToken
      if (refreshToken !== undefined) target.refreshToken = refreshToken
    },
  }
}

function apiFetchOpts(
  target: DeployTarget,
  method: string,
  path: string,
  body?: unknown,
): TargetFetchOptions {
  const authRefresh = cloudAuthRefresh(target)
  return {
    method,
    path,
    token: target.token!,
    ...(body !== undefined ? { body } : {}),
    ...(target.orgId !== undefined ? { orgId: target.orgId } : {}),
    ...(target.mode === "cloud" ? { environment: target.environment } : {}),
    ...(authRefresh !== undefined ? { authRefresh } : {}),
  }
}

function projectPath(target: DeployTarget, subpath: string): string {
  return `/projects/${target.projectRef}${subpath}`
}

/**
 * Run the engine for `target`: in the project's engine image when it has one, else the host binary.
 */
async function engineHere<T>(
  target: DeployTarget,
  endpoint: string,
  body: Record<string, unknown>,
  guard: Guard<T>,
): Promise<T> {
  if (target.compose === undefined) await ensureEngine()
  return engineRequest(endpoint, body, guard, target.compose)
}

/** Whether `target` runs the engine binary here rather than asking a control plane. */
function runsEngineHere(target: DeployTarget): boolean {
  return target.mode === "direct" || (target.mode === "local" && !target.token)
}

/** Nothing about a server says when it changed, so its answer is trusted for a while. */
const serverCapabilitiesCache: CapabilitiesCache<Capabilities> = capabilitiesCache(CAPABILITIES_TTL_MS)

/** Forget every server's answer, as if none had been asked (tests). */
export function forgetServerCapabilities(): void {
  serverCapabilitiesCache.answers.clear()
}

/**
 * What `target` supports: the project's engine image when the engine runs in compose, the engine
 * binary's own answer when it runs here, otherwise the control plane's
 * `GET <schema base>/capabilities`. Only an answer is remembered, for a while; a request
 * that failed is made again next time.
 */
export async function targetCapabilities(target: DeployTarget): Promise<Capabilities> {
  if (target.compose !== undefined) return target.compose.capabilities()
  if (runsEngineHere(target)) return engineCapabilities()
  const key = [target.apiBaseUrl, target.apiPrefix, target.projectRef, target.environment].join("\0")
  return rememberCapabilities(serverCapabilitiesCache, key, () => serverCapabilities(target))
}

/**
 * Ask the control plane. A route it does not have (404) is a server from before the check, which
 * supports no ownership feature: it would drop the fields, not forward them. A project it does not
 * know is not that, and saying "update it" sent people to update a server that was fine (A6-N2).
 */
async function serverCapabilities(target: DeployTarget): Promise<Capabilities> {
  let answer: unknown
  try {
    answer = await targetFetch(
      target.apiBaseUrl,
      target.apiPrefix,
      apiFetchOpts(target, "GET", projectPath(target, "/schema/capabilities")),
    )
  } catch (err: unknown) {
    if (!(err instanceof TargetApiError)) throw err
    if (isUnknownProject(err)) throw new Error(unknownProjectMessage(target, err))
    if (err.status !== 404) throw err
  }
  return { features: parseCapabilities(answer) ?? new Set(), source: "server" }
}

/**
 * The server's answer for a project it has no record of: the cloud's 404 "Project not found", or a
 * self-hosted control plane's "Unknown project ref". Both say `not_found` for a missing route as
 * well, so the wording is what tells them apart.
 */
function isUnknownProject(err: TargetApiError): boolean {
  return /project not found|unknown project ref/i.test(err.message)
}

function unknownProjectMessage(target: DeployTarget, err: TargetApiError): string {
  return (
    `The server has no project "${target.projectRef}" (${err.message}). ` +
    "Check the project this directory is linked to (.supatype/link.json): it must be the project's ref."
  )
}

/**
 * Refuse, before anything is sent, an ownership feature `target` does not support: "this server
 * does not support <flag>; update it". Never asks when nothing is needed.
 */
export async function requireTargetFeatures(target: DeployTarget, needs: readonly FeatureNeed[]): Promise<void> {
  if (needs.length === 0) return
  assertSupported(await targetCapabilities(target), needs)
}

export async function targetSchemaDiff(
  target: DeployTarget,
  ast: unknown,
  opts?: { schema?: string },
): Promise<DiffResult> {
  await requireTargetFeatures(target, identityColumnsNeed(ast))
  if (target.mode === "direct" || (target.mode === "local" && !target.token)) {
    return engineHere(
      target,
      "/diff",
      { ast, database_url: target.databaseUrl!, schema: opts?.schema ?? "public" },
      isDiffResult,
    )
  }

  return targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "POST", projectPath(target, "/schema/diff"), {
      ast,
      schema: opts?.schema ?? "public",
    }),
    isDiffResult,
  )
}

export async function targetSchemaPush(
  target: DeployTarget,
  ast: unknown,
  opts: {
    /** The project directory: whose push this is, for the audit trail. */
    cwd: string
    force?: boolean
    schema?: string
    schemaSources?: SchemaSourcesPayload | null
    /** Put back access changed outside Supatype (plan 3.5); only after consent. */
    overwriteDrift?: boolean
  },
): Promise<EnginePushResult> {
  const overwriteDrift = opts.overwriteDrift === true
  await requireTargetFeatures(target, [
    ...(overwriteDrift ? [{ feature: "overwrite_drift" as const, flag: "--overwrite-drift" }] : []),
    ...identityColumnsNeed(ast),
  ])
  if (runsEngineHere(target)) {
    const body: Record<string, unknown> = {
      ast,
      database_url: target.databaseUrl!,
      schema: opts.schema ?? "public",
      force: opts.force ?? true,
      ...(overwriteDrift && { overwrite_drift: true }),
    }
    if (opts.schemaSources) {
      body["schema_sources_gz_base64"] = opts.schemaSources.dataBase64
      body["schema_sources_manifest"] = opts.schemaSources.manifest
    }
    if (target.compose === undefined) await ensureEngine()
    return enginePush(opts.cwd, body, isEnginePushResult, target.compose)
  }

  const pushBody: Record<string, unknown> = {
    ast,
    force: opts.force ?? true,
    schema: opts.schema ?? "public",
    // The engine's own name, which a control plane forwards as it is.
    ...(overwriteDrift && { overwrite_drift: true }),
    // Who is pushing. A control plane records the identity it authenticated instead.
    ...pushAuditFields(opts.cwd),
  }
  if (opts.schemaSources) {
    pushBody["schemaSources"] = {
      manifest: opts.schemaSources.manifest,
      dataBase64: opts.schemaSources.dataBase64,
    }
  }

  return targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "POST", projectPath(target, "/schema/push"), pushBody),
    isEnginePushResult,
  )
}

export interface SchemaRollbackResult {
  status: string
  name: string
  message: string
  restoredMigrationName?: string | null
  schemaSourcesManifest?: SchemaSourcesManifestSummary | null
  schemaSourcesBase64?: string
}

export interface SchemaSourcesManifestSummary {
  entryPoint?: string
  fileCount?: number
  compressedBytes?: number
  pushedBy?: string
  files?: Array<{ path: string }>
}

export interface MigrationListEntry {
  id: number
  name: string
  hash: string
  appliedAt: string
  rolledBack: boolean
  engineVersion: string
  status: string
  schemaSourcesManifest?: SchemaSourcesManifestSummary | null
  /** Who pushed it: verified when a control plane authenticated them. Absent before the audit trail. */
  pushedBy?: string | null
  pushedVia?: string | null
  pushedFrom?: string | null
  pushedByVerified?: boolean | null
  /** Each rename it applied, with who declared it and when. */
  renames?: AppliedRenameRecord[] | null
}

export async function targetSchemaRollback(
  target: DeployTarget,
  opts?: { schema?: string },
): Promise<SchemaRollbackResult> {
  if (target.mode === "direct" || (target.mode === "local" && !target.token)) {
    // A refused rollback (nothing to undo, or dropped data undo cannot bring back) is said as the
    // engine says it, as a control plane's 409 already is.
    return engineHere(
      target,
      "/rollback",
      { database_url: target.databaseUrl!, schema: opts?.schema ?? "public" },
      isSchemaRollbackResult,
    ).catch((err: unknown) => {
      throw asTheEngineRefused(err)
    })
  }

  return targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "POST", projectPath(target, "/schema/rollback"), {
      schema: opts?.schema ?? "public",
    }),
    isSchemaRollbackResult,
  )
}

export async function targetListMigrations(
  target: DeployTarget,
): Promise<MigrationListEntry[]> {
  if (target.mode === "direct" || (target.mode === "local" && !target.token)) {
    const result = await engineHere(
      target,
      "/migrations",
      { database_url: target.databaseUrl!, action: "list" },
      isMigrationsAnswer,
    )
    return Array.isArray(result) ? result : (result.migrations ?? [])
  }

  return targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "GET", projectPath(target, "/schema/migrations")),
    isMigrationList,
  )
}

/**
 * Where `doctor` and `adopt` look: the linked environment, else the local dev database, unless
 * `--direct` or `--connection` asks for the engine subprocess. One answer for both, so `adopt` takes
 * exactly what `doctor` reported. `dev-compose` is loaded only when the local database is the
 * answer, as `push` loads it.
 *
 * A docker project without `overrides.engine` runs the engine in its own image, as push does, so
 * nothing is published to the host for it and the engine that adopts is the one that pushed.
 */
export async function schemaCommandTarget(
  cwd: string,
  config: SupatypeProjectConfig,
  opts: { connection?: string; env?: string; direct?: boolean },
): Promise<DeployTarget> {
  if (opts.direct || opts.connection) {
    return resolveTarget(cwd, { env: opts.env, direct: true, connection: opts.connection })
  }
  if (loadProjectLink(cwd)) return resolveTarget(cwd, { env: opts.env })
  const { projectComposeEngine, resolveHostEngineDatabaseUrl } = await import("./dev-compose.js")
  const compose = await projectComposeEngine(cwd, config)
  if (compose !== undefined) {
    return { ...resolveTarget(cwd, { direct: true, connection: compose.databaseUrl }), compose }
  }
  const connection = await resolveHostEngineDatabaseUrl(cwd, config)
  return resolveTarget(cwd, { direct: true, connection })
}

/**
 * `doctor` on a target. With `rebaseline`, the drift it finds is first recorded as the new baseline
 * (no object changes) and listed as rebaselined; access drift (policies, grants, labels, RLS) only
 * with `acceptAccessDrift` as well (`accept_access_drift`; `overwrite_drift` is push's alone), else
 * listed as `rebaselineRefused`. With `keys` (the drifted objects its preview showed, named as
 * doctor names them) it records only if the drift is still exactly those, and otherwise is refused
 * with `drift_changed`, writing nothing.
 */
export async function targetSchemaDoctor(
  target: DeployTarget,
  ast: unknown,
  opts?: { schema?: string; rebaseline?: boolean; acceptAccessDrift?: boolean; keys?: string[] },
): Promise<DoctorReport> {
  const rebaseline = opts?.rebaseline === true
  const acceptAccessDrift = rebaseline && opts?.acceptAccessDrift === true
  const keys = rebaseline ? opts?.keys : undefined
  const body = {
    ast,
    schema: opts?.schema ?? "public",
    ...(rebaseline && { rebaseline: true }),
    ...(acceptAccessDrift && { accept_access_drift: true }),
    ...(keys !== undefined && { keys }),
  }
  // A server or engine that dropped `keys` would record drift nobody was shown: refused, never sent.
  await requireTargetFeatures(target, [
    ...(rebaseline ? [{ feature: "rebaseline", flag: "--rebaseline" } as const] : []),
    ...(acceptAccessDrift ? [{ feature: "accept_access_drift", flag: "--accept-access-drift" } as const] : []),
    ...(keys !== undefined ? [REBASELINE_KEYS_NEED] : []),
    ...identityColumnsNeed(ast),
  ])
  if (runsEngineHere(target)) {
    return engineHere(target, "/doctor", { ...body, database_url: target.databaseUrl! }, isDoctorReport)
  }

  return targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "POST", projectPath(target, "/schema/doctor"), body),
    isDoctorReport,
  )
}

export async function targetSchemaIntrospect(
  target: DeployTarget,
  opts?: { schema?: string },
): Promise<DatabaseStateJson> {
  if (target.mode === "direct" || (target.mode === "local" && !target.token)) {
    return engineHere(
      target,
      "/introspect",
      { database_url: target.databaseUrl!, schema: opts?.schema ?? "public" },
      isDatabaseStateJson,
    )
  }

  return targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "POST", projectPath(target, "/schema/introspect"), {
      schema: opts?.schema ?? "public",
    }),
    isDatabaseStateJson,
  )
}

/**
 * `adopt` on a target: hand the objects a push refuses to Supatype, take back the ones named in
 * `release`, and hand back the released ones named in `reclaim` (`kind:table.name`, as doctor names
 * them). A preview unless `yes`; with `keys` (the conflicts a preview showed, named the same way)
 * only those are adopted, and nothing is written if one of them is no longer a conflict.
 *
 * An empty `keys` adopts nothing: the engine binary is told so with `--adopt-none` (see
 * `endpointToArgs`), and its server reads `keys: []` the same way.
 */
export async function targetSchemaAdopt(
  target: DeployTarget,
  ast: unknown,
  opts?: { release?: string[]; reclaim?: string[]; keys?: string[]; schema?: string; yes?: boolean },
): Promise<AdoptOutcome> {
  const release = opts?.release ?? []
  const reclaim = opts?.reclaim ?? []
  const body = {
    ast,
    schema: opts?.schema ?? "public",
    yes: opts?.yes ?? false,
    ...(release.length > 0 && { release }),
    ...(reclaim.length > 0 && { reclaim }),
    ...(opts?.keys !== undefined && { keys: opts.keys }),
  }
  // A server that dropped `keys` would adopt every conflict, and one that dropped `release` would
  // adopt instead of release: refused before sending, never degraded.
  await requireTargetFeatures(target, [...adoptNeeds({ keys: opts?.keys, release, reclaim }), ...identityColumnsNeed(ast)])
  if (runsEngineHere(target)) {
    return engineHere(target, "/adopt", { ...body, database_url: target.databaseUrl! }, isAdoptOutcome)
  }
  return targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "POST", projectPath(target, "/schema/adopt"), body),
    isAdoptOutcome,
  )
}

/**
 * The target's status from its control plane. `cwd` is the project, for the local stack's key.
 */
export async function targetStatus(target: DeployTarget, cwd: string = process.cwd()): Promise<unknown> {
  if (target.mode === "direct") {
    return { mode: "direct", environment: target.environment }
  }

  return targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(withLocalStackKey(target, cwd), "GET", projectPath(target, "/status")),
  )
}

/**
 * `target`, carrying the local dev stack's service-role key when it has no token of its own.
 *
 * An unlinked dev project resolves to a `local` target with no token, deliberately: without one
 * its schema commands run the engine here instead of asking the control plane, so the key is added
 * only for a request that has to ask the control plane anyway. The gateway requires the key on
 * `/platform/v1` in dev too, and this used to send `Bearer undefined`, which passed only while dev
 * waved every request through. With no key in `.env` either, nothing is sent at all.
 */
function withLocalStackKey(target: DeployTarget, cwd: string): DeployTarget {
  if (target.mode !== "local" || target.token) return target
  const token = configuredServiceRoleKey(cwd)
  if (token === undefined) {
    throw new Error("No service-role key for the local stack in .env. Run: supatype dev, or supatype keys")
  }
  return { ...target, token }
}

export function schemaPgSchema(cwd: string): string {
  return pgSchema(loadConfig(cwd))
}

export { schemaPathFromProject }
