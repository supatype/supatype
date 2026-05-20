/** CDN-cached binaries resolved by the CLI (`engine`, `server`, `postgres`, `deno`). */
export const BINARY_COMPONENTS = ["engine", "server", "postgres", "deno"] as const

export type Component = (typeof BINARY_COMPONENTS)[number]

export type ComponentVersions = Record<Component, string>
