/**
 * A static site's public values on a target: what `supatype push` sends, and what `supatype site env`
 * lists, sets and unsets. The routes are the same on Supatype Cloud and a self-host stack for the
 * push (`PUT /site/env/config`); the rest are Cloud's, where Studio can set values too.
 *
 * A value is checked here before any request, by the rules the server repeats (`@supatype/shared`),
 * so a refusal names the value without a round trip.
 */

import { isArrayOf, isOneOf, isShape, isString } from "@supatype/shared"
import { prefixedPublicEnv, publicEnvFor, publicEnvProblems, publicEnvRefusal } from "@supatype/types"
import { loadConfig, mainConfigFile } from "./config.js"
import { errorMessage } from "./error-message.js"
import { loadProjectLink } from "./link.js"
import { resolveTarget, type DeployTarget } from "./resolve-target.js"
import { targetRequest } from "./target-request.js"
import { TargetApiError, targetFetch } from "./target-client.js"

/** Where a value is set: the config's `build.publicEnv` (read-only in Studio), or Studio. */
export type PublicEnvSource = "config" | "studio"

/** One value in effect on an environment. */
export interface PublicEnvEntry {
  name: string
  value: string
  source: PublicEnvSource
}

const isEntry = isShape({ name: isString, value: isString, source: isOneOf(["config", "studio"]) })
const isEntries = isShape({ entries: isArrayOf(isEntry) })

function assertAllowed(values: Readonly<Record<string, string>>): void {
  const problems = publicEnvProblems(values)
  if (problems.length > 0) throw new Error(publicEnvRefusal(problems, String.fromCharCode(10)))
}

/** A server from before public values answers its router's 404, not a project's. */
function predatesPublicValues(err: unknown): boolean {
  return err instanceof TargetApiError && err.status === 404 && /route not found/i.test(err.message)
}

/**
 * Send the values `build.publicEnv` gives the target's environment, replacing the ones an earlier
 * push sent. Sent on every push, empty when the config names none, so a value taken out of the
 * config goes from the site. A server that predates public values has none to clear, so an empty
 * set to it is not an error; a set with values in it is, since the site would never read them.
 */
export async function pushPublicEnv(target: DeployTarget, values: Readonly<Record<string, string>>): Promise<void> {
  assertAllowed(values)
  try {
    await targetFetch(target.apiBaseUrl, target.apiPrefix, targetRequest(target, { method: "PUT", subpath: "/site/env/config", body: { values } }))
  } catch (err) {
    if (!predatesPublicValues(err)) throw err
    if (Object.keys(values).length === 0) return
    throw new Error(`${target.apiBaseUrl} does not serve public values: update it, or remove build.publicEnv from supatype.config.ts`, { cause: err })
  }
}

/** The values in effect on the target's environment, each with where it is set. */
export async function listPublicEnv(target: DeployTarget): Promise<PublicEnvEntry[]> {
  const answer = await targetFetch(target.apiBaseUrl, target.apiPrefix, targetRequest(target, { method: "GET", subpath: "/site/env" }), isEntries)
  return answer.entries
}

/** Set one value on the target's environment, as Studio would. The server refuses a name the config sets. */
export async function setPublicEnv(target: DeployTarget, name: string, value: string): Promise<void> {
  assertAllowed({ [name]: value })
  await targetFetch(target.apiBaseUrl, target.apiPrefix, targetRequest(target, { method: "PUT", subpath: `/site/env/${encodeURIComponent(name)}`, body: { value } }))
}

/** Remove one value set on the target's environment. The server refuses a name the config sets. */
export async function deletePublicEnv(target: DeployTarget, name: string): Promise<void> {
  await targetFetch(target.apiBaseUrl, target.apiPrefix, targetRequest(target, { method: "DELETE", subpath: `/site/env/${encodeURIComponent(name)}` }))
}

/** The values a build cannot be given: Cloud holds some set in Studio and did not hand them over. */
export class PublicEnvUnavailable extends Error {
  constructor(environment: string, reason: string) {
    super(`Could not read the public values set in Studio for "${environment}": ${reason}. A build without them would ship a site that reads none of them.`)
    this.name = "PublicEnvUnavailable"
  }
}

export interface BuildPublicEnvOptions {
  /** The linked environment to build for (`--env`), else the link's default; production with no link. */
  env?: string | undefined
}

/** The public values a build is given, by where each is set. The config's win; see {@link buildPublicVars}. */
export interface BuildPublicValues {
  /** `build.publicEnv` for the environment. */
  config: Record<string, string>
  /** What was set in Studio, for the names the config does not set. Only on a Cloud link. */
  studio: Record<string, string>
}

/**
 * The public values a build of the site is given: `build.publicEnv` for the environment, and on a
 * Cloud link the ones set in Studio. A project with no link takes the config's alone. A Cloud that
 * cannot say what Studio set refuses the build rather than ship without them; one that predates
 * public values has none.
 */
export async function resolveBuildPublicEnv(cwd: string, opts: BuildPublicEnvOptions): Promise<BuildPublicValues> {
  // An app folder with no config of its own can still build with what Studio set.
  const declared = mainConfigFile(cwd) === undefined ? undefined : loadConfig(cwd).build?.publicEnv
  if (loadProjectLink(cwd) === null) return { config: publicEnvFor(declared, opts.env ?? "production"), studio: {} }
  const target = resolveTarget(cwd, { env: opts.env, tokenOptional: true })
  const fromConfig = publicEnvFor(declared, target.environment)
  if (target.mode !== "cloud") return { config: fromConfig, studio: {} }
  try {
    const entries = await listPublicEnv(target)
    const studio = Object.fromEntries(entries.filter((entry) => entry.source === "studio" && !(entry.name in fromConfig)).map((entry) => [entry.name, entry.value]))
    return { config: fromConfig, studio }
  } catch (err) {
    if (predatesPublicValues(err)) return { config: fromConfig, studio: {} }
    throw new PublicEnvUnavailable(target.environment, errorMessage(err))
  }
}

/**
 * The variables that give a build the site's public values, under every framework's prefix, to be
 * laid over its environment. The config's values win; then a variable the shell already sets (so a
 * CI host's own setting beats Studio's, name for name); then Studio's. Studio's value is left out of
 * the result for a name the shell sets, so the shell's stays.
 */
export function buildPublicVars(values: BuildPublicValues, shell: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const studio = Object.fromEntries(Object.entries(prefixedPublicEnv(values.studio)).filter(([name]) => shell[name] === undefined))
  return { ...studio, ...prefixedPublicEnv(values.config) }
}
