/**
 * The two variables a Next.js server (or any server-side code) reads the deployment's address and
 * anon key from: `createServerClient`'s defaults, and the values `@supatype/ssr/next` serves to the
 * page. They are read where the app runs, so one build serves whichever deployment it runs as. A
 * `NEXT_PUBLIC_` name, fixed into the build, is only the server client's fallback.
 */

export const SERVER_URL_ENV = "SUPATYPE_URL"
export const SERVER_ANON_KEY_ENV = "SUPATYPE_ANON_KEY"

/**
 * Where `createServerClient` looks for each value: the server's own name first, read where the app
 * runs, then the Next.js build-time name an app may already set. The route serves only the first.
 */
export const SERVER_URL_NAMES = [SERVER_URL_ENV, "NEXT_PUBLIC_SUPATYPE_URL"] as const
export const SERVER_ANON_KEY_NAMES = [SERVER_ANON_KEY_ENV, "NEXT_PUBLIC_SUPATYPE_ANON_KEY"] as const

/**
 * A variable from the server's environment, trimmed; undefined when unset or blank, and where there
 * is no `process` at all. Read by name at call time, so no bundler can fix its build-time value in.
 */
export function serverEnv(name: string): string | undefined {
  if (typeof process === "undefined" || typeof process.env !== "object") return undefined
  const value = process.env[name]?.trim()
  return value === undefined || value === "" ? undefined : value
}
