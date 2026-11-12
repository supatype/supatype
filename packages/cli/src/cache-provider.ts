/**
 * Which RESP server this stack runs: one decision, in one place.
 *
 * The response cache and Kong's ACME certificates share a RESP server. Since P1 that can be
 * pg_keyspace inside the Postgres container: one stateful service instead of two, no second
 * image to keep patched, and a cache whose memory is accounted for in the database's own
 * reservation. That is now the default rather than the option.
 *
 * **Valkey stays selectable**, and stays the answer for `database.external`: pg_keyspace is loaded
 * through `shared_preload_libraries`, which is a property of a Postgres this stack starts. Against
 * a database Supatype does not manage there is nothing to configure, so the fallback is not a
 * preference; it is the only thing that can run.
 *
 * A resolver rather than a default written into the config type, because the answer depends on
 * more than one field: the same absent `cache.provider` means pg_keyspace beside a managed
 * database and Valkey beside an external one. A default baked into the parser would have to be
 * either wrong for one of them or applied twice, and applied twice is how the compose file and the
 * native path end up disagreeing about which server is running: a cache that silently never hits
 * and, with TLS on, a Kong that cannot store its certificate.
 */
import { KEYSPACE_AUTH_SINCE, postgresImageFor } from "./postgres-image.js"
import type { SupatypeProjectConfig } from "./project-config.js"

export type CacheProvider = "valkey" | "pg_keyspace"

/**
 * The provider this project runs under Docker, explicit or resolved.
 *
 * An explicit `cache.provider` is honoured exactly, including `"valkey"`, which is how a project
 * keeps the sidecar it has. `validateProjectConfig` has already refused the one explicit
 * combination that cannot run (pg_keyspace against `database.external`), so this never overrides
 * what someone wrote.
 *
 * Otherwise it follows the image actually run, as `postgresImageFor` resolves it for the compose
 * file too: `database.external` is Valkey, since there is no container to preload a library in;
 * an `X-latest` image or an exact one from `KEYSPACE_TOGGLE_SINCE` is pg_keyspace; an exact image
 * before it, or a custom `database.image` nothing can vouch for, is Valkey. An image without the
 * toggle ignores `SUPATYPE_KEYSPACE_ENABLED` and starts with no RESP listener, which is not an
 * error anywhere: the stack comes up and the cache never hits.
 */
export function cacheProvider(config: SupatypeProjectConfig): CacheProvider {
  const declared = config.cache?.provider
  if (declared === "valkey" || declared === "pg_keyspace") return declared
  if (config.database?.external) return "valkey"
  return postgresImageFor(config).keyspace ? "pg_keyspace" : "valkey"
}

/** Whether the RESP keyspace is served by the Postgres container this stack starts. */
export function keyspaceInPostgres(config: SupatypeProjectConfig): boolean {
  return cacheProvider(config) === "pg_keyspace"
}

/**
 * Whether native dev asks its Postgres for the keyspace: an explicit choice wins, an external
 * database is Valkey, and otherwise yes. A `versions.postgres` pin does not decide, unlike under
 * Docker, because native sets pg_keyspace up itself rather than through an image toggle: it checks
 * that the archive carries the library and can require a password (KEYSPACE_AUTH_SINCE or later),
 * hands it the project's password in a file, and checks that RESP answers a client that logs in
 * with it, falling back to the Valkey sidecar if any of that does not hold (native-keyspace.ts).
 */
export function nativeKeyspaceWanted(config: SupatypeProjectConfig): boolean {
  const declared = config.cache?.provider
  if (declared === "valkey" || declared === "pg_keyspace") return declared === "pg_keyspace"
  return !config.database?.external
}

/**
 * Whether this stack's keyspace requires the project's password: it is in the Postgres container,
 * and that image takes `SUPATYPE_KEYSPACE_PASSWORD` (`KEYSPACE_AUTH_SINCE`). Valkey is reached only
 * on the compose network and has no password; an older image would ignore one, and the server would
 * then send AUTH to a keyspace that refuses it (0.9.2 release test, N-RB2).
 */
export function keyspacePasswordRequired(config: SupatypeProjectConfig): boolean {
  return keyspaceInPostgres(config) && postgresImageFor(config).keyspaceAuth
}

/**
 * The line dev and self-host say at start when this stack's keyspace is in a Postgres image that
 * cannot require a password, or null. Such an image (a `versions.postgres` pin before
 * KEYSPACE_AUTH_SINCE) is given none, so the keyspace answers anything on the compose network, and
 * nothing said so (0.9.2 round 2, R2-S15).
 */
export function openKeyspaceNotice(config: SupatypeProjectConfig): string | null {
  if (!keyspaceInPostgres(config)) return null
  const image = postgresImageFor(config)
  if (image.keyspaceAuth) return null
  return (
    `${image.ref ?? "This Postgres image"} cannot require a keyspace password, so the keyspace is open to ` +
    `anything on the compose network. supatype/postgres ${KEYSPACE_AUTH_SINCE} or later closes it.`
  )
}
