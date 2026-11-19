/**
 * `build.publicEnv` in supatype.config.ts: the public, non-secret values a static site reads, each
 * one string for every environment or a map of environment name to string. What a value may be is
 * decided in `@supatype/types` (public-env.ts); this checks the config's shape and applies it, so a
 * bad value stops at `supatype push` and never reaches a deployment.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { isJsonObject, isString } from "@supatype/shared"
import {
  ENVIRONMENT_NAME,
  isPublicEnvDeclaration,
  publicEnvFor,
  publicEnvProblems,
  type PublicEnvDeclaration,
} from "@supatype/types"
import { objectAt } from "./ast-read.js"
import { readJsonObjectFile } from "./json-file.js"
import { patchRouteManifest } from "./route-manifest.js"
import type { SupatypeProjectConfig } from "./project-config.js"

/** Why one value is not a string or a map of environment name to string, said by config key. */
function shapeProblem(name: string, value: unknown, filename: string): string | undefined {
  const at = `${filename}: build.publicEnv.${name}`
  if (isString(value)) return undefined
  if (!isJsonObject(value)) return `${at} must be a string, or a map of environment name to string`
  for (const [environment, entry] of Object.entries(value)) {
    if (!ENVIRONMENT_NAME.test(environment)) return `${at}: "${environment}" is not an environment name (lower case letters, digits, "-" and "_")`
    if (!isString(entry)) return `${at}.${environment} must be a string`
  }
  return undefined
}

/** Throws the first reason `section` is not a `build.publicEnv`, for a section {@link isPublicEnvDeclaration} refused. */
function refuseShape(section: Record<string, unknown>, filename: string): never {
  for (const [name, value] of Object.entries(section)) {
    const problem = shapeProblem(name, value, filename)
    if (problem !== undefined) throw new Error(problem)
  }
  throw new Error(`${filename}: build.publicEnv is not a map of name to value`)
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
  if (!isPublicEnvDeclaration(section)) refuseShape(section, filename)
  const declared = section
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

/** The environment a local stack, and `supatype dev`, serves the values of. */
export const LOCAL_ENVIRONMENT = "local"

/** Said when the manifest's public values were rewritten. */
export const PUBLIC_ENV_WRITTEN = "Public values written to .supatype/manifest.json"

/**
 * Write the values `build.publicEnv` gives a local stack into `.supatype/manifest.json`, where the
 * server reads `public_env` and serves it at `/supatype-env.js`. An empty set takes the key out, so
 * a value removed from the config goes from the site.
 *
 * Only a manifest that is already there is updated, and one that cannot be read is left for the
 * server to report: the compose path owns creating it, and a manifest carrying only this says
 * nothing of functions (see syncManifestHooks). Returns true when the file was rewritten.
 */
export function syncManifestPublicEnv(cwd: string, config: SupatypeProjectConfig): boolean {
  const manifestPath = join(cwd, ".supatype", "manifest.json")
  if (!existsSync(manifestPath)) return false
  const current = readJsonObjectFile(manifestPath)
  if (current === undefined) return false
  const values = publicEnvFor(config.build?.publicEnv, LOCAL_ENVIRONMENT)
  const next = Object.keys(values).length > 0 ? values : undefined
  if (JSON.stringify(next) === JSON.stringify(current["public_env"])) return false
  patchRouteManifest(manifestPath, { public_env: next }, { keepMalformed: true })
  return true
}
