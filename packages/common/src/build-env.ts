function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * A variable a bundler put on `import.meta.env` (Vite and its kin), when there is one and it is a
 * non-empty string. Read through checks rather than a declared type: `import.meta.env` exists only
 * when a bundler made it, and holds whatever that bundler put there.
 */
export function importMetaEnv(name: string): string | undefined {
  if (typeof import.meta === "undefined") return undefined
  const meta: unknown = import.meta
  const env = isRecord(meta) ? meta["env"] : undefined
  const value = isRecord(env) ? env[name] : undefined
  return typeof value === "string" && value !== "" ? value : undefined
}
