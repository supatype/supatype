/**
 * A request to the linked project's API, with the time limit its route needs: one policy for every
 * command that calls the target, so a functions deploy and a hook upload wait alike.
 */
import { projectRequest, type DeployTarget } from "./resolve-target.js"
import type { TargetFetchOptions } from "./target-client.js"

/**
 * How long a request to the linked target may take. A deploy, a hook upload and a delete can
 * restart the worker before they answer, which often takes more than 10 s, so they get longer. So
 * does an env change: it restarts nothing itself, but starts a worker that stopped and pays a
 * restart a failed deploy owes.
 */
const TARGET_TIMEOUT_MS = 10_000
const RESTART_TIMEOUT_MS = 60_000
/**
 * More time for each function or hook a request carries: Supatype Cloud syncs them in turn within
 * the one request, so a fixed limit timed a large deploy out while the server deployed every one.
 */
const PER_HANDLER_TIMEOUT_MS = 30_000

/** One request to the linked project's API, at `/projects/<ref><subpath>`. */
export interface TargetCall {
  method: string
  subpath: string
  body?: unknown
  /** Whether the route restarts the worker before it answers. */
  restartsWorker?: boolean
  /** How many functions or hooks the call carries, each given {@link PER_HANDLER_TIMEOUT_MS} more. */
  handlers?: number
}

/** `call` to the target's project, with the time limit its route needs. */
export function targetRequest(target: DeployTarget, call: TargetCall): TargetFetchOptions {
  const base = call.restartsWorker === true ? RESTART_TIMEOUT_MS : TARGET_TIMEOUT_MS
  const timeoutMs = base + (call.handlers ?? 0) * PER_HANDLER_TIMEOUT_MS
  return { ...projectRequest(target, call.method, call.subpath, call.body), timeoutMs }
}
