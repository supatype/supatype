/**
 * `build.publicEnv` in supatype.config.ts: the public, non-secret values a static site reads, each
 * one string for every environment or a map of environment name to string. What a value may be is
 * decided in `@supatype/shared` (public-env.ts); this checks the config's shape and applies it, so a
 * bad value stops at `supatype push` and never reaches a deployment.
 */

import { isJsonObject, isString, publicEnvFor, publicEnvProblems, type PublicEnvDeclaration } from "@supatype/shared"
import { objectAt } from "./ast-read.js"

/** An environment name as Cloud accepts it. */
const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/

/** One value's shape: a string, or a map of environment name to string. Throws naming the key. */
function checkedEntry(name: string, value: unknown, filename: string): string | Record<string, string> {
  const at = `${filename}: build.publicEnv.${name}`
  if (isString(value)) return value
  if (!isJsonObject(value)) throw new Error(`${at} must be a string, or a map of environment name to string`)
  const perEnvironment: Record<string, string> = {}
  for (const [environment, entry] of Object.entries(value)) {
    if (!ENVIRONMENT_NAME.test(environment)) throw new Error(`${at}: "${environment}" is not an environment name (lower case letters, digits, "-" and "_")`)
    if (!isString(entry)) throw new Error(`${at}.${environment} must be a string`)
    perEnvironment[environment] = entry
  }
  return perEnvironment
}

/** The environments a declaration names in its maps; production when it names none, so a plain value is still checked. */
function namedEnvironments(declared: PublicEnvDeclaration): string[] {
  const names = new Set(Object.values(declared).flatMap((entry) => (isString(entry) ? [] : Object.keys(entry))))
  return names.size > 0 ? [...names] : ["production"]
}

/**
 * `build.publicEnv`, when set, is checked: its shape, then every name and value for every environment
 * it names against the rules for a public value. Throws one error listing each refusal by config key,
 * never repeating a value. Nothing serves the values when the server publishes no public env, so that
 * is refused too rather than left to look like it worked.
 */
export function validateBuildPublicEnv(cfg: Readonly<Record<string, unknown>>, filename: string): void {
  const section = objectAt(cfg, "build")?.["publicEnv"]
  if (section === undefined) return
  if (!isJsonObject(section)) throw new Error(`${filename}: build.publicEnv must be an object of name to value, as in { MAPS_KEY: "abc" }`)
  const declared: Record<string, string | Record<string, string>> = {}
  for (const [name, value] of Object.entries(section)) declared[name] = checkedEntry(name, value, filename)
  const lines = new Set<string>()
  for (const environment of namedEnvironments(declared)) {
    for (const problem of publicEnvProblems(publicEnvFor(declared, environment))) {
      lines.add(problem.name === "" ? `build.publicEnv ${problem.reason}` : `build.publicEnv.${problem.name} ${problem.reason}`)
    }
  }
  if (lines.size > 0) throw new Error(`${filename}: ${[...lines].join("; ")}`)
  if (Object.keys(declared).length > 0 && objectAt(cfg, "server")?.["public_env"] === false) {
    throw new Error(`${filename}: build.publicEnv is set but server.public_env is false, so nothing would serve the values`)
  }
}
