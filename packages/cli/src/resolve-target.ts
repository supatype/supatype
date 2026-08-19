import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { loadConfig } from "./config.js"
import type { DiffResult } from "./engine-client.js"
import { ensureEngine, engineRequest } from "./engine-client.js"
import type { SchemaSourcesPayload } from "./schema-sources.js"
import {
  connectionString,
  pgSchema,
  resolveRuntimeProvider,
  schemaPathFromProject,
  serverBaseUrl,
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
import { targetFetch, type TargetFetchOptions } from "./target-client.js"

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
  /** Cloud GoTrue refresh token (mode === "cloud" only). */
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
    const localEnv = loadLocalEnvironment(cwd)
    return {
      mode: "direct",
      environment: "local",
      projectRef,
      apiBaseUrl: (serverBaseUrl(config) ?? "").replace(/\/$/, ""),
      apiPrefix: "/platform/v1",
      link: null,
      databaseUrl:
        flags.connection ??
        localEnv?.databaseUrl ??
        connectionString(config),
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
        databaseUrl: localEnv.databaseUrl,
      }
    }
    return {
      mode: "direct",
      environment: "local",
      projectRef,
      apiBaseUrl: (serverBaseUrl(config) ?? "").replace(/\/$/, ""),
      apiPrefix: "/platform/v1",
      link: null,
      databaseUrl: flags.connection ?? connectionString(config),
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
  opts?: { force?: boolean; schema?: string; schemaSources?: SchemaSourcesPayload | null },
): Promise<{ message?: string; status?: string; name?: string }> {
  if (target.mode === "direct" || (target.mode === "local" && !target.token)) {
    await ensureEngine()
    const body: Record<string, unknown> = {
      ast,
      database_url: target.databaseUrl!,
      schema: opts?.schema ?? "public",
      force: opts?.force ?? true,
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
  opts?: { noCache?: boolean | undefined; schema?: string },
): Promise<unknown> {
  if (target.mode === "direct" || (target.mode === "local" && !target.token)) {
    await ensureEngine()
    return engineRequest("/doctor", {
      ast,
      database_url: target.databaseUrl!,
      schema: opts?.schema ?? "public",
      no_cache: opts?.noCache ?? false,
    })
  }

  return targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "POST", projectPath(target, "/schema/doctor"), {
      ast,
      no_cache: opts?.noCache ?? false,
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

export async function targetSchemaAdopt(
  target: DeployTarget,
  ast: unknown,
  opts?: { names?: string[]; schema?: string; yes?: boolean; noCache?: boolean },
): Promise<unknown> {
  if (target.mode === "direct" || (target.mode === "local" && !target.token)) {
    await ensureEngine()
    return engineRequest("/adopt", {
      ast,
      database_url: target.databaseUrl!,
      schema: opts?.schema ?? "public",
      names: opts?.names,
      yes: opts?.yes ?? false,
      no_cache: opts?.noCache ?? false,
    })
  }

  return targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    apiFetchOpts(target, "POST", projectPath(target, "/schema/adopt"), {
      ast,
      schema: opts?.schema ?? "public",
      yes: opts?.yes ?? false,
      no_cache: opts?.noCache ?? false,
      ...(opts?.names !== undefined ? { names: opts.names } : {}),
    }),
  )
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
