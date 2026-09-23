/**
 * Which RESP server this stack runs: one decision, in one place.
 *
 * The response cache and Kong's ACME certificates share a RESP server. Since P1 that can be
 * pg_keyspace inside the Postgres container — one stateful service instead of two, no second
 * image to keep patched, and a cache whose memory is accounted for in the database's own
 * reservation. That is now the default rather than the option.
 *
 * **Valkey stays selectable**, and stays the answer for `database.external`: pg_keyspace is loaded
 * through `shared_preload_libraries`, which is a property of a Postgres this stack starts. Against
 * a database Supatype does not manage there is nothing to configure, so the fallback is not a
 * preference — it is the only thing that can run.
 *
 * A resolver rather than a default written into the config type, because the answer depends on
 * more than one field: the same absent `cache.provider` means pg_keyspace beside a managed
 * database and Valkey beside an external one. A default baked into the parser would have to be
 * either wrong for one of them or applied twice, and applied twice is how the compose file and the
 * native path end up disagreeing about which server is running — a cache that silently never hits
 * and, with TLS on, a Kong that cannot store its certificate.
 */
import { pinnedVersion } from "./binary-cache.js"
import type { SupatypeProjectConfig } from "./project-config.js"

export type CacheProvider = "valkey" | "pg_keyspace"

/**
 * The provider this project runs, explicit or resolved.
 *
 * An explicit `cache.provider` is honoured exactly — including `"valkey"`, which is how a project
 * keeps the sidecar it has. `validateProjectConfig` has already refused the one explicit
 * combination that cannot run (pg_keyspace against `database.external`), so this never overrides
 * what someone wrote.
 *
 * The two things that resolve an absent one to Valkey are both cases where this cannot know that a
 * keyspace would work:
 *
 *  - **`database.external`**: pg_keyspace is loaded through `shared_preload_libraries`, and there
 *    is no container here to set that on.
 *  - **A pinned `versions.postgres`**: the keyspace is served by the image, and the entrypoint
 *    honours `SUPATYPE_KEYSPACE_ENABLED` only from the release that introduced it. An older image
 *    ignores the variable and starts with no RESP listener, which is not an error anywhere — the
 *    stack comes up and the cache never hits. A pin says this project's image is fixed, and a
 *    default must not assume something about a fixed image it cannot check. Unpinned tracks
 *    latest, which carries the toggle by definition.
 *
 * A project on a pin that *does* carry the toggle says `cache: { provider: "pg_keyspace" }` and
 * gets it — which is also the only instruction anyone needs, and is better than a version floor
 * here that would have to be right about a release number in another repository.
 */
export function cacheProvider(config: SupatypeProjectConfig): CacheProvider {
  const declared = config.cache?.provider
  if (declared === "valkey" || declared === "pg_keyspace") return declared
  if (config.database?.external) return "valkey"
  if (pinnedVersion("postgres", config) !== undefined) return "valkey"
  return "pg_keyspace"
}

/** Whether the RESP keyspace is served by the Postgres this stack starts. */
export function keyspaceInPostgres(config: SupatypeProjectConfig): boolean {
  return cacheProvider(config) === "pg_keyspace"
}
