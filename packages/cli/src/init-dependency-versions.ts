import { cliPackageVersion } from "./cli-package-version.js"
import { isRecordOf, isShape, isString, isUnknown, optional, type Guard } from "@supatype/shared"

export interface InitDependencyVersions {
  cli: string
  types: string
  /** The runtime client the generated `supatype/generated/client.ts` imports. */
  client: string
}

type NpmRegistryPackage = {
  versions?: Record<string, unknown>
  "dist-tags"?: { latest?: string }
}

/** The part of an npm registry document read here. */
const isNpmRegistryPackage: Guard<NpmRegistryPackage> = isShape({
  versions: optional(isRecordOf(isUnknown)),
  "dist-tags": optional(isShape({ latest: optional(isString) })),
})

/** Fallback when the registry is unreachable (offline / tests). */
export function initDependencyVersionsFallback(): InitDependencyVersions {
  const version = cliPackageVersion()
  return { cli: version, types: version, client: version }
}

async function fetchNpmPackage(name: string): Promise<NpmRegistryPackage | null> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!resp.ok) return null
    const meta = await resp.json()
    return isNpmRegistryPackage(meta) ? meta : null
  } catch {
    return null
  }
}

function versionPublishedOnNpm(meta: NpmRegistryPackage | null, version: string): boolean {
  return Boolean(meta?.versions?.[version])
}

function latestPublishedOnNpm(meta: NpmRegistryPackage | null): string | null {
  const latest = meta?.["dist-tags"]?.latest
  return typeof latest === "string" && latest.trim() !== "" ? latest.trim() : null
}

function resolvePackageVersion(
  meta: NpmRegistryPackage | null,
  preferred: string,
): string {
  if (versionPublishedOnNpm(meta, preferred)) return preferred
  const latest = latestPublishedOnNpm(meta)
  if (latest) return latest
  return preferred
}

/**
 * Pick @supatype/cli, @supatype/types and @supatype/client versions that exist on npm.
 * The running CLI may be a local dev build ahead of the registry (e.g. 0.1.3
 * while types is only published at 0.1.1).
 */
export async function resolveInitDependencyVersions(): Promise<InitDependencyVersions> {
  const runningCli = cliPackageVersion()
  const [cliMeta, typesMeta, clientMeta] = await Promise.all([
    fetchNpmPackage("@supatype/cli"),
    fetchNpmPackage("@supatype/types"),
    fetchNpmPackage("@supatype/client"),
  ])

  if (!cliMeta && !typesMeta && !clientMeta) {
    return initDependencyVersionsFallback()
  }

  return {
    cli: resolvePackageVersion(cliMeta, runningCli),
    types: resolvePackageVersion(typesMeta, runningCli),
    client: resolvePackageVersion(clientMeta, runningCli),
  }
}
