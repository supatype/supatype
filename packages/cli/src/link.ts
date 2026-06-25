import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
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
  token?: string
  orgId?: string | undefined
  cloudApiUrl?: string
  linkedAt: string
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

export function writeLocalEnvironment(cwd: string, env: LocalEnvironment): void {
  const dir = resolve(cwd, ".supatype")
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, "environment.json"), `${JSON.stringify(env, null, 2)}\n`, "utf8")
}

export function loadLocalEnvironment(cwd: string): LocalEnvironment | null {
  const path = resolve(cwd, ".supatype/environment.json")
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, "utf8")) as LocalEnvironment
}

export function linkPath(cwd: string): string {
  return resolve(cwd, LINK_FILE)
}

export function loadProjectLink(cwd: string): ProjectLink | null {
  migrateLegacyLinkFiles(cwd)
  const path = linkPath(cwd)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, "utf8")) as ProjectLink
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
    cloud = JSON.parse(readFileSync(cloudPath, "utf8")) as LegacyCloudFile
  }
  if (hasLinked) {
    linked = JSON.parse(readFileSync(linkedPath, "utf8")) as LegacyLinkedFile
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
  }
}
