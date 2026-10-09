import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { loadConfig } from "./config.js"
import type { AdoptOutcome } from "./adopt-walkthrough.js"
import type { DiffResult } from "./engine-client.js"
import { ensureEngine, engineRequest } from "./engine-client.js"
import type { SchemaSourcesPayload } from "./schema-sources.js"
import { resolveHostDatabaseUrl } from "./host-database.js"
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
import {
  adoptNeeds,
  assertSupported,
  engineCapabilities,
  parseCapabilities,
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
}

export function loadLocalEnvironmentFile(cwd: string): LocalEnvironment | null {
  return loadLocalEnvironment(cwd)
}

function readServiceRoleKey(cwd: string): string | undefined {
  return process.env["SERVICE_ROLE_KEY"] ?? process.env["SUPATYPE_SERVICE_ROLE_KEY"]
}

function resolveLocalToken(cwd: string): string | undefined {
  return readServiceRoleKey(cwd)
}

export function loadBranchContext(cwd: string): BranchContext | null {
  const path = resolve(cwd, ".supatype/branch.json")
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, "utf8")) as BranchContext
}

function resolveBranchDefaults(cwd: string, configEnvDefault?: string): string | undefined {
  if (configEnvDefault) return configEnvDefault
  try {
    const config = loadConfig(cwd)
    const branchDefaults = config.environments?.branchDefaults
    if (!branchDefaults) return undefined
    const { execSync } = require("node:child_process") as typeof import("node:child_process")
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
        token: resolveLocalToken(cwd),
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

/** Whether `target` runs the engine binary here rather than asking a control plane. */
function runsEngineHere(target: DeployTarget): boolean {
  return target.mode === "direct" || (target.mode === "local" && !target.token)
}

const capabilitiesOf = new WeakMap<DeployTarget, Capabilities>()

/**
 * What `target` supports: the engine binary's own answer when it runs here, otherwise the control
 * plane's `GET <schema base>/capabilities`. A control plane without the route (404) is from before
 * it, and supports no ownership feature: it would drop the fields, not forward them.
 */
export async function targetCapabilities(target: DeployTarget): Promise<Capabilities> {
  const known = capabilitiesOf.get(target)
  if (known !== undefined) return known
  let caps: Capabilities
  if (runsEngineHere(target)) {
    caps = await engineCapabilities()
  } else {
    let answer: unknown
    try {
      answer = await targetFetch<unknown>(
        target.apiBaseUrl,
        target.apiPrefix,
        apiFetchOpts(target, "GET", projectPath(target, "/schema/capabilities")),
      )
    } catch (err: unknown) {
      if (!(err instanceof TargetApiError && err.status === 404)) throw err
    }
    caps = { features: parseCapabilities(answer) ?? new Set(), source: "server" }
  }
  capabilitiesOf.set(target, caps)
  return caps
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
  if (target.mode === "direct" || (target.mode === "local" && !target.token)) {
    await ensureEngine()
    return engineRequest<DiffResult>("/diff", {
      ast,
      database_url: target.databaseUrl!,
      schema: opts?.schema ?? "public",
    })
  }

  return targetFetch<DiffResult>(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "POST", projectPath(target, "/schema/diff"), {
      ast,
      schema: opts?.schema ?? "public",
    }),
  )
}

export async function targetSchemaPush(
  target: DeployTarget,
  ast: unknown,
  opts?: {
    force?: boolean
    schema?: string
    schemaSources?: SchemaSourcesPayload | null
    /** Put back access changed outside Supatype (plan 3.5); only after consent. */
    overwriteDrift?: boolean
  },
): Promise<{
  message?: string
  status?: string
  name?: string
  /** The schema's warnings, then any found once applied. See `printPushWarnings`. */
  warnings?: string[]
  /**
   * What the control plane made of this schema's cache declaration. Absent from an engine push and
   * from a control plane too old to send it, which is why every reader of it has to treat absence
   * as "nothing to say" rather than as an empty declaration.
   */
  cache?: { tables?: string[]; honoured?: boolean }
}> {
  const overwriteDrift = opts?.overwriteDrift === true
  await requireTargetFeatures(target, overwriteDrift ? [{ feature: "overwrite_drift", flag: "--overwrite-drift" }] : [])
  if (runsEngineHere(target)) {
    await ensureEngine()
    const body: Record<string, unknown> = {
      ast,
      database_url: target.databaseUrl!,
      schema: opts?.schema ?? "public",
      force: opts?.force ?? true,
      ...(overwriteDrift && { overwrite_drift: true }),
    }
    if (opts?.schemaSources) {
      body["schema_sources_gz_base64"] = opts.schemaSources.dataBase64
      body["schema_sources_manifest"] = opts.schemaSources.manifest
    }
    return engineRequest("/push", body)
  }

  const pushBody: Record<string, unknown> = {
    ast,
    force: opts?.force ?? true,
    schema: opts?.schema ?? "public",
    // The engine's own name, which a control plane forwards as it is.
    ...(overwriteDrift && { overwrite_drift: true }),
  }
  if (opts?.schemaSources) {
    pushBody["schemaSources"] = {
      manifest: opts.schemaSources.manifest,
      dataBase64: opts.schemaSources.dataBase64,
    }
  }

  return targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "POST", projectPath(target, "/schema/push"), pushBody),
  )
}

export interface SchemaRollbackResult {
  status: string
  name: string
  message: string
  restoredMigrationName?: string
  schemaSourcesManifest?: SchemaSourcesManifestSummary
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
}

export async function targetSchemaRollback(
  target: DeployTarget,
  opts?: { schema?: string },
): Promise<SchemaRollbackResult> {
  if (target.mode === "direct" || (target.mode === "local" && !target.token)) {
    await ensureEngine()
    return engineRequest<SchemaRollbackResult>("/rollback", {
      database_url: target.databaseUrl!,
      schema: opts?.schema ?? "public",
    })
  }

  return targetFetch<SchemaRollbackResult>(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "POST", projectPath(target, "/schema/rollback"), {
      schema: opts?.schema ?? "public",
    }),
  )
}

export async function targetListMigrations(
  target: DeployTarget,
): Promise<MigrationListEntry[]> {
  if (target.mode === "direct" || (target.mode === "local" && !target.token)) {
    await ensureEngine()
    const result = await engineRequest<{ migrations?: MigrationListEntry[] } | MigrationListEntry[]>(
      "/migrations",
      { database_url: target.databaseUrl!, action: "list" },
    )
    return Array.isArray(result) ? result : (result.migrations ?? [])
  }

  return targetFetch<MigrationListEntry[]>(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "GET", projectPath(target, "/schema/migrations")),
  )
}

export async function targetSchemaDoctor(
  target: DeployTarget,
  ast: unknown,
  opts?: { schema?: string },
): Promise<unknown> {
  if (target.mode === "direct" || (target.mode === "local" && !target.token)) {
    await ensureEngine()
    return engineRequest("/doctor", {
      ast,
      database_url: target.databaseUrl!,
      schema: opts?.schema ?? "public",
    })
  }

  return targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "POST", projectPath(target, "/schema/doctor"), {
      ast,
      schema: opts?.schema ?? "public",
    }),
  )
}

export async function targetSchemaIntrospect(
  target: DeployTarget,
  opts?: { schema?: string },
): Promise<unknown> {
  if (target.mode === "direct" || (target.mode === "local" && !target.token)) {
    await ensureEngine()
    return engineRequest("/introspect", {
      database_url: target.databaseUrl!,
      schema: opts?.schema ?? "public",
    })
  }

  return targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "POST", projectPath(target, "/schema/introspect"), {
      schema: opts?.schema ?? "public",
    }),
  )
}

/**
 * `adopt` on a target: hand the objects a push refuses to Supatype, and take back the ones named in
 * `release` (`kind:table.name`, as doctor names them). A preview unless `yes`; with `keys` (the
 * conflicts a preview showed, named the same way) only those are adopted, and nothing is written if
 * one of them is no longer a conflict.
 *
 * An empty `keys` adopts nothing: the engine binary is told so with `--adopt-none` (see
 * `endpointToArgs`), and its server reads `keys: []` the same way.
 */
export async function targetSchemaAdopt(
  target: DeployTarget,
  ast: unknown,
  opts?: { release?: string[]; keys?: string[]; schema?: string; yes?: boolean },
): Promise<AdoptOutcome> {
  const release = opts?.release ?? []
  const body = {
    ast,
    schema: opts?.schema ?? "public",
    yes: opts?.yes ?? false,
    ...(release.length > 0 && { release }),
    ...(opts?.keys !== undefined && { keys: opts.keys }),
  }
  // A server that dropped `keys` would adopt every conflict, and one that dropped `release` would
  // adopt instead of release: refused before sending, never degraded.
  await requireTargetFeatures(target, adoptNeeds({ keys: opts?.keys, release }))
  if (runsEngineHere(target)) {
    await ensureEngine()
    return engineRequest<AdoptOutcome>("/adopt", { ...body, database_url: target.databaseUrl! })
  }
  return (await targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "POST", projectPath(target, "/schema/adopt"), body),
  )) as AdoptOutcome
}

export async function targetStatus(target: DeployTarget): Promise<unknown> {
  if (target.mode === "direct") {
    return { mode: "direct", environment: target.environment }
  }

  return targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "GET", projectPath(target, "/status")),
  )
}

export function schemaPgSchema(cwd: string): string {
  return pgSchema(loadConfig(cwd))
}

export { schemaPathFromProject }
