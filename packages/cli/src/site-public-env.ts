/**
 * A static site's public values on a target: what `supatype push` sends, and what `supatype site env`
 * lists, sets and unsets. The routes are the same on Supatype Cloud and a self-host stack for the
 * push (`PUT /site/env/config`); the rest are Cloud's, where Studio can set values too.
 *
 * A value is checked here before any request, by the rules the server repeats (`@supatype/shared`),
 * so a refusal names the value without a round trip.
 */

import { isArrayOf, isOneOf, isShape, isString, publicEnvProblems, type PublicEnvProblem } from "@supatype/shared"
import type { DeployTarget } from "./resolve-target.js"
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

/** The refusals as one message, naming each value and never repeating it. */
export function refusalMessage(problems: readonly PublicEnvProblem[]): string {
  return problems.map((p) => (p.name === "" ? `The public values: ${p.reason}` : `${p.name} ${p.reason}`)).join("\n")
}

function assertAllowed(values: Readonly<Record<string, string>>): void {
  const problems = publicEnvProblems(values)
  if (problems.length > 0) throw new Error(refusalMessage(problems))
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
