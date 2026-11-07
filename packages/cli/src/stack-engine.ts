/**
 * Which engine a host-side command runs when it reaches a database by URL.
 *
 * `push` and `diff` run the project's compose engine image. A command that ran the host binary
 * instead ran a second engine on the same project: `seed` (fresh-user test C3) refused a schema
 * the image had just pushed, and `migrate` (issue 63) wrote SQL from the released engine that the
 * push no longer ran. Every such command now asks here.
 */

import type { SupatypeConfig } from "./config.js"
import { databaseUrlHostPort, isLocalDatabaseUrl } from "./db-port.js"
import { engineRequest, ensureEngine, type ComposeEngine } from "./engine-client.js"
import type { Capabilities, FeatureNeed } from "./engine-ownership-gate.js"
import type { Guard } from "@supatype/shared"

/**
 * The project's compose engine when `dsn` is the stack's own database, otherwise the host binary
 * (undefined).
 *
 * Only for the stack's own database: the compose engine reaches it inside the stack network, so a
 * `--connection` or a database on another machine stays with the host binary, which connects to
 * the URL it was given.
 */
export async function stackEngine(
  cwd: string,
  config: SupatypeConfig,
  connection: string | undefined,
  dsn: string,
): Promise<ComposeEngine | undefined> {
  if (connection !== undefined && connection.trim() !== "") return undefined
  if (!(await isStackDatabaseUrl(cwd, config, dsn))) return undefined
  const { projectComposeEngine } = await import("./dev-compose.js")
  return projectComposeEngine(cwd, config)
}

/**
 * True when `dsn` is the stack's own database as the host reaches it: on this machine, at the port
 * the stack's layout publishes Postgres on. A local URL at any other port is another Postgres, which
 * the compose engine, connecting inside the stack network, would not reach.
 */
async function isStackDatabaseUrl(cwd: string, config: SupatypeConfig, dsn: string): Promise<boolean> {
  if (!isLocalDatabaseUrl(dsn)) return false
  // Imported here: resolve-target imports this module, and these reach the compose layout.
  const { composeRenderMode } = await import("./compose-render-mode.js")
  const { composeDbHostPort } = await import("./host-database.js")
  return databaseUrlHostPort(dsn)?.port === composeDbHostPort(cwd, composeRenderMode(cwd, config.project.name))
}

/** What `engine` supports, or the host binary when there is none. */
export async function capabilitiesIn(engine: ComposeEngine | undefined): Promise<Capabilities> {
  if (engine !== undefined) return engine.capabilities()
  return (await import("./engine-ownership-gate.js")).engineCapabilities()
}

/** Refuse, before anything is sent, a need `engine` (or the host binary when none) does not support. */
export async function requireEngineFeaturesIn(engine: ComposeEngine | undefined, needs: readonly FeatureNeed[]): Promise<void> {
  if (needs.length === 0) return
  const { assertSupported } = await import("./engine-ownership-gate.js")
  assertSupported(await capabilitiesIn(engine), needs)
}

/** Run `endpoint` in `engine`, or in the host binary, made ready first, when there is none. */
export async function engineRequestIn<T>(
  engine: ComposeEngine | undefined,
  endpoint: string,
  body: Record<string, unknown>,
  guard: Guard<T>,
): Promise<T> {
  if (engine === undefined) await ensureEngine()
  return engineRequest(endpoint, body, guard, engine)
}
