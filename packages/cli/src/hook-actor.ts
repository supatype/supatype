/**
 * PostgREST's db-pre-request for after-hooks, and which servers it may be named for.
 *
 * The server's `auth.emit_hook_actor()`, run by PostgREST before each request in that request's own
 * transaction, writes the caller into the change log beside the request's writes. That is how the
 * after-hook listener tells an API write, and who made it, from a write made in SQL.
 *
 * PostgREST calls the pre-request function on every request, and one that does not exist fails them
 * all. So it is named only for a server whose migrations create it: a project pinned to an older
 * server keeps a working API, and its after-hooks get no caller.
 */
import { compareVersions } from "./engine-floor.js"
import { defaultComponentVersion } from "./release-images.js"
import type { SupatypeProjectConfig } from "./project-config.js"

/** The setting, as compose and native dev pass it to PostgREST. */
export const POSTGREST_HOOK_ACTOR_ENV = { PGRST_DB_PRE_REQUEST: "auth.emit_hook_actor" } as const

/**
 * The first server release whose migrations create `auth.emit_hook_actor()` (server migration
 * 20261103180000_add_hook_actor_marker). Must equal that release's version: set it when the server
 * is released, before the CLI release that pins it.
 */
export const SERVER_MIN_FOR_HOOK_ACTOR = "2.3.0"

/** Server pins that are not a release number, and run the server built from source or the newest. */
const UNNUMBERED_SERVER_PINS: ReadonlySet<string> = new Set(["local", "latest"])

/**
 * {@link POSTGREST_HOOK_ACTOR_ENV} when the project's server creates the function, else nothing.
 * The server is the project's `versions.server` pin, or the one this CLI release pins.
 */
export function postgrestHookActorEnv(config: SupatypeProjectConfig): typeof POSTGREST_HOOK_ACTOR_ENV | Record<string, never> {
  const pinned = config.versions?.server?.trim()
  const server = pinned !== undefined && pinned !== "" ? pinned : defaultComponentVersion("server")
  if (server === undefined) return {}
  if (UNNUMBERED_SERVER_PINS.has(server)) return POSTGREST_HOOK_ACTOR_ENV
  return compareVersions(server, SERVER_MIN_FOR_HOOK_ACTOR) >= 0 ? POSTGREST_HOOK_ACTOR_ENV : {}
}
