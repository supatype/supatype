/** CDN-cached components resolved by the CLI (`engine`, `server`, `postgres`, `deno`, `realtime`, `storage`). */
export const BINARY_COMPONENTS = ["engine", "server", "postgres", "deno", "realtime", "storage"] as const

export type Component = (typeof BINARY_COMPONENTS)[number]

/**
 * Built in this repository and released with the CLI at its own version (no pin of their own): a
 * release CLI runs its own, and one before their first release finds no latest.json for them.
 */
export const RELEASE_VERSIONED_COMPONENTS: ReadonlySet<Component> = new Set(["realtime", "storage"])

export type ComponentVersions = Record<Component, string>
