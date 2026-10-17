import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { isNumber, isOneOf, isRecordOf, isShape, isString, optional, type Guard } from "@supatype/shared"
import { readJsonFileOrThrow } from "./json-file.js"
import { warn } from "./ui/messages.js"

export const LINK_VERSION = 1 as const
export const LINK_FILE = ".supatype/link.json"
export const LEGACY_CLOUD_FILE = ".supatype/cloud.json"
export const LEGACY_LINKED_FILE = ".supatype/linked.json"

export type ProjectLinkKind = "cloud" | "self-host" | "local"

export interface EnvironmentTarget {
  name: string
  apiUrl: string
  token?: string
  linkedAt: string
}

export interface ProjectLink {
  version: typeof LINK_VERSION
  kind: ProjectLinkKind
  projectRef: string
  defaultEnvironment: string
  /** Access token (cloud user JWT) or self-host SERVICE_ROLE_KEY. */
  token?: string
  /** Cloud auth refresh token, used to renew short-lived access JWTs. */
  refreshToken?: string
  orgId?: string | undefined
  cloudApiUrl?: string
  /** When the link was made. Never read, and absent from a hand-written link. */
  linkedAt?: string
  environments: Record<string, EnvironmentTarget>
}

export interface LocalEnvironment {
  target: "local"
  apiUrl: string
  databaseUrl: string
  projectRef: string
  kongPort: number
  provider: "docker" | "native"
}

export interface BranchContext {
  mode: "branch"
  branchId: string
  apiUrl: string
  token?: string | undefined
}

interface LegacyCloudFile {
  apiUrl?: string
  token?: string
  projectSlug?: string
  orgId?: string
}

interface LegacyLinkedFile {
  ref?: string
  orgId?: string
}

const isEnvironmentTarget: Guard<EnvironmentTarget> = isShape({
  name: isString,
  apiUrl: isString,
  token: optional(isString),
  linkedAt: isString,
})

const isProjectLink: Guard<ProjectLink> = isShape({
  version: isOneOf([LINK_VERSION]),
  kind: isOneOf(["cloud", "self-host", "local"] as const),
  projectRef: isString,
  defaultEnvironment: isString,
  token: optional(isString),
  refreshToken: optional(isString),
  orgId: optional(isString),
  cloudApiUrl: optional(isString),
  linkedAt: optional(isString),
  environments: isRecordOf(isEnvironmentTarget),
})

const isLocalEnvironment: Guard<LocalEnvironment> = isShape({
  target: isOneOf(["local"] as const),
  apiUrl: isString,
  databaseUrl: isString,
  projectRef: isString,
  kongPort: isNumber,
  provider: isOneOf(["docker", "native"] as const),
})

/** `.supatype/branch.json`: the branch a directory is pointed at. */
export const isBranchContext: Guard<BranchContext> = isShape({
  mode: isOneOf(["branch"] as const),
  branchId: isString,
  apiUrl: isString,
  token: optional(isString),
})

const isLegacyCloudFile: Guard<LegacyCloudFile> = isShape({
  apiUrl: optional(isString),
  token: optional(isString),
  projectSlug: optional(isString),
  orgId: optional(isString),
})

const isLegacyLinkedFile: Guard<LegacyLinkedFile> = isShape({ ref: optional(isString), orgId: optional(isString) })

export function writeLocalEnvironment(cwd: string, env: LocalEnvironment): void {
  const dir = resolve(cwd, ".supatype")
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, "environment.json"), `${JSON.stringify(env, null, 2)}\n`, "utf8")
}

export function loadLocalEnvironment(cwd: string): LocalEnvironment | null {
  const path = resolve(cwd, ".supatype/environment.json")
  if (!existsSync(path)) return null
  return readJsonFileOrThrow(path, isLocalEnvironment, "a local environment")
}

export function linkPath(cwd: string): string {
  return resolve(cwd, LINK_FILE)
}

export function loadProjectLink(cwd: string): ProjectLink | null {
  migrateLegacyLinkFiles(cwd)
  const path = linkPath(cwd)
  if (!existsSync(path)) return null
  return readJsonFileOrThrow(path, isProjectLink, "a project link")
}

export function saveProjectLink(cwd: string, link: ProjectLink): void {
  const dir = resolve(cwd, ".supatype")
  mkdirSync(dir, { recursive: true })
  writeFileSync(linkPath(cwd), `${JSON.stringify(link, null, 2)}\n`, "utf8")
}

export function isProjectLinked(cwd: string): boolean {
  const link = loadProjectLink(cwd)
  return Boolean(link?.projectRef && Object.keys(link.environments).length > 0)
}

export function resolveEnvironmentName(link: ProjectLink, envFlag?: string): string {
  if (envFlag?.trim()) return envFlag.trim()
  return link.defaultEnvironment || "production"
}

export function getEnvironmentTarget(link: ProjectLink, envName: string): EnvironmentTarget | null {
  return link.environments[envName] ?? null
}

export function resolveEnvironmentToken(link: ProjectLink, env: EnvironmentTarget): string | undefined {
  return env.token ?? link.token
}

let migrationWarned = false

/** Merge legacy cloud.json + linked.json into link.json once. */
export function migrateLegacyLinkFiles(cwd: string): void {
  const target = linkPath(cwd)
  if (existsSync(target)) return

  const cloudPath = resolve(cwd, LEGACY_CLOUD_FILE)
  const linkedPath = resolve(cwd, LEGACY_LINKED_FILE)
  const hasCloud = existsSync(cloudPath)
  const hasLinked = existsSync(linkedPath)
  if (!hasCloud && !hasLinked) return

  let cloud: LegacyCloudFile | null = null
  let linked: LegacyLinkedFile | null = null

  if (hasCloud) {
    cloud = readJsonFileOrThrow(cloudPath, isLegacyCloudFile, "a cloud link")
  }
  if (hasLinked) {
    linked = readJsonFileOrThrow(linkedPath, isLegacyLinkedFile, "a linked project")
  }

  const projectRef = cloud?.projectSlug ?? linked?.ref
  if (!projectRef || !cloud?.token) {
    return
  }

  const now = new Date().toISOString()
  const link: ProjectLink = {
    version: LINK_VERSION,
    kind: "cloud",
    projectRef,
    defaultEnvironment: "production",
    token: cloud.token,
    cloudApiUrl: cloud.apiUrl ?? "https://api.supatype.com",
    linkedAt: now,
    environments: {
      production: {
        name: "production",
        apiUrl: cloud.apiUrl ?? "https://api.supatype.com",
        linkedAt: now,
      },
    },
    ...(cloud.orgId !== undefined
      ? { orgId: cloud.orgId }
      : linked?.orgId !== undefined
        ? { orgId: linked.orgId }
        : {}),
  }

  saveProjectLink(cwd, link)

  if (!migrationWarned) {
    migrationWarned = true
    warn(
      "Migrated .supatype/cloud.json → .supatype/link.json (legacy files kept; remove manually when ready).",
    )
  }
}

export function createSelfHostLink(params: {
  projectRef: string
  apiUrl: string
  token: string
  envName?: string
  existing?: ProjectLink | null
}): ProjectLink {
  const envName = params.envName ?? "production"
  const now = new Date().toISOString()
  const env: EnvironmentTarget = {
    name: envName,
    apiUrl: params.apiUrl.replace(/\/$/, ""),
    token: params.token,
    linkedAt: now,
  }

  if (params.existing) {
    return {
      ...params.existing,
      kind: params.existing.kind === "cloud" ? "self-host" : params.existing.kind,
      projectRef: params.projectRef,
      defaultEnvironment: params.existing.defaultEnvironment || envName,
      linkedAt: now,
      environments: {
        ...params.existing.environments,
        [envName]: env,
      },
    }
  }

  return {
    version: LINK_VERSION,
    kind: "self-host",
    projectRef: params.projectRef,
    defaultEnvironment: envName,
    token: params.token,
    linkedAt: now,
    environments: { [envName]: env },
  }
}

export function createCloudLink(params: {
  projectRef: string
  cloudApiUrl: string
  token: string
  refreshToken?: string
  orgId?: string | undefined
  environments?: Array<{ name: string; apiUrl: string }>
  existing?: ProjectLink | null
}): ProjectLink {
  const now = new Date().toISOString()
  const envMap: Record<string, EnvironmentTarget> = {}
  const envs = params.environments?.length
    ? params.environments
    : [{ name: "production", apiUrl: params.cloudApiUrl }]

  for (const e of envs) {
    envMap[e.name] = {
      name: e.name,
      apiUrl: e.apiUrl.replace(/\/$/, ""),
      linkedAt: now,
    }
  }

  const refreshToken = params.refreshToken ?? params.existing?.refreshToken

  return {
    version: LINK_VERSION,
    kind: "cloud",
    projectRef: params.projectRef,
    defaultEnvironment: "production",
    token: params.token,
    cloudApiUrl: params.cloudApiUrl.replace(/\/$/, ""),
    linkedAt: now,
    environments: params.existing
      ? { ...params.existing.environments, ...envMap }
      : envMap,
    ...(params.orgId !== undefined ? { orgId: params.orgId } : {}),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
  }
}
