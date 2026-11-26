/**
 * A static site's public values on a target: what `supatype push` sends, and what `supatype site env`
 * lists, sets and unsets. The routes are the same on Supatype Cloud and a self-host stack for the
 * push (`PUT /site/env/config`); the rest are Cloud's, where Studio can set values too.
 *
 * A value is checked here before any request, by the rules the server repeats (`@supatype/types`,
 * public-env.ts), so a refusal names the value without a round trip.
 */

import { isArrayOf, isShape } from "@supatype/shared"
import {
  isPublicEnvEntry,
  prefixedPublicEnv,
  publicEnvFor,
  publicEnvProblems,
  publicEnvRefusal,
  type PublicEnvDeclaration,
  type PublicEnvEntry,
} from "@supatype/types"
import { BuildRefused } from "./build-refused.js"
import { loadConfig, mainConfigFile } from "./config.js"
import { errorMessage } from "./error-message.js"
import { loadProjectLink } from "./link.js"
import { resolveTarget, type DeployTarget } from "./resolve-target.js"
import { targetRequest } from "./target-request.js"
import { TargetApiError, targetFetch } from "./target-client.js"

const isEntries = isShape({ entries: isArrayOf(isPublicEnvEntry) })

/** How many values, said the same way by push, deploy and `site env pull`. */
export function publicValueCount(count: number): string {
  return `${count} public value(s)`
}

function assertAllowed(values: Readonly<Record<string, string>>): void {
  const problems = publicEnvProblems(values)
  if (problems.length > 0) throw new Error(publicEnvRefusal(problems, "\n"))
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
export class PublicEnvUnavailable extends BuildRefused {
  constructor(environment: string, reason: string) {
    super(`Could not read the public values set in Studio for "${environment}": ${reason}. A build without them would ship a site that reads none of them.`)
    this.name = "PublicEnvUnavailable"
  }
}

/** `build.publicEnv` as the project's config declares it, or undefined: an app folder with no config of its own declares none. */
export function declaredPublicEnv(cwd: string): PublicEnvDeclaration | undefined {
  return mainConfigFile(cwd) === undefined ? undefined : loadConfig(cwd).build?.publicEnv
}

/** The environment a command is about, the Cloud target when the project is linked to Cloud, and the config's values for it. */
export interface SiteScope {
  environment: string
  /** Set only on a Cloud link. */
  cloud: DeployTarget | undefined
  /** `build.publicEnv` for {@link SiteScope.environment}. */
  config: Record<string, string>
}

export interface SiteScopeOptions {
  /** The linked environment (`--env`), else the link's default; production with no link. */
  env?: string | undefined
  /** Resolve a Cloud link that has no session yet, for a build that fails later with its own words. */
  tokenOptional?: boolean
}

/**
 * Read the link and the config once, for every command about the site's public values: which
 * environment, whether it is Cloud's, and the values the config gives it. An app folder with no
 * config of its own has none, and can still build with what Studio set.
 */
export function siteScope(cwd: string, opts: SiteScopeOptions): SiteScope {
  const declared = declaredPublicEnv(cwd)
  if (loadProjectLink(cwd) === null) {
    const environment = opts.env ?? "production"
    return { environment, cloud: undefined, config: publicEnvFor(declared, environment) }
  }
  const target = resolveTarget(cwd, { env: opts.env, ...(opts.tokenOptional === true && { tokenOptional: true }) })
  return { environment: target.environment, cloud: target.mode === "cloud" ? target : undefined, config: publicEnvFor(declared, target.environment) }
}

function configEntries(config: Readonly<Record<string, string>>): PublicEnvEntry[] {
  return Object.entries(config).map(([name, value]) => ({ name, value, source: "config" }))
}

/**
 * The public values a build of the site is given: the config's for the environment, and on a Cloud
 * link the ones set in Studio for the names the config does not set. A Cloud that cannot say what
 * Studio set refuses the build rather than ship without them; one that predates public values has
 * none.
 */
export async function resolveBuildPublicEnv(scope: SiteScope): Promise<PublicEnvEntry[]> {
  const fromConfig = configEntries(scope.config)
  if (scope.cloud === undefined) return fromConfig
  try {
    const entries = await listPublicEnv(scope.cloud)
    return [...fromConfig, ...entries.filter((entry) => entry.source === "studio" && !(entry.name in scope.config))]
  } catch (err) {
    if (predatesPublicValues(err)) return fromConfig
    throw new PublicEnvUnavailable(scope.environment, errorMessage(err))
  }
}

/**
 * The variables that give a build the site's public values, under every framework's prefix, to be
 * laid over its environment. The config's values win; then a variable the shell already sets (so a
 * CI host's own setting beats Studio's, name for name); then Studio's, which is left out of the
 * result for a name the shell sets so the shell's stays.
 */
export function buildPublicVars(entries: readonly PublicEnvEntry[], shell: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const valuesOf = (source: PublicEnvEntry["source"]): Record<string, string> =>
    Object.fromEntries(entries.filter((entry) => entry.source === source).map((entry) => [entry.name, entry.value]))
  const studio = Object.entries(prefixedPublicEnv(valuesOf("studio"))).filter(([name]) => shell[name] === undefined)
  return { ...Object.fromEntries(studio), ...prefixedPublicEnv(valuesOf("config")) }
}
