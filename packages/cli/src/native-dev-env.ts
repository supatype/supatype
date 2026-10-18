/**
 * What the native Postgres install decides about the services `supatype dev` starts beside it.
 *
 * Kept out of the dev action so the decisions are testable. Each one is asked of the install's
 * filesystem (see `postgres-ctl.ts`), and a wiring line dropped from a 600-line action would
 * otherwise go unnoticed: the server would forward `/graphql/v1` to a PostgREST that cannot answer
 * it, or PostgREST would be pointed at the wrong schemas for the tier the push will use.
 */

import { fieldMaskingTierFromProject } from "./field-masking-tier.js"
import { splitPassword } from "./host-database.js"
import { projectHasVersionedModels } from "./model-versioning.js"
import { nativeRolesSql } from "./native-roles-sql.js"
import { nativeGraphqlServerEnv, nativeMaskLibraryPresent } from "./postgres-ctl.js"
import { postgrestSchemaEnv, type SupatypeProjectConfig } from "./project-config.js"

/** Inputs to the outer layer of supatype-server's environment on the native path. */
export interface NativeServerCoreInput {
  mode: string
  /** Empty when no keyspace or Valkey sidecar is reachable. */
  valkeyAddr: string
  projectRef: string
  manifestPath: string
  adminConfigPath: string
  postgrestPort: string
  pgBinDir: string | null
  /** The project database on this machine, which is where the native server reaches it too. */
  databaseUrl: string
}

/**
 * supatype-server's outer layer: mode, cache, manifest paths, PostgREST and GraphQL, and the
 * database as this machine reaches it, without its password, for Studio's connection strings.
 */
export function nativeServerCoreEnv(input: NativeServerCoreInput): Record<string, string> {
  return {
    SUPATYPE_MODE: input.mode,
    ...(input.valkeyAddr ? { SUPATYPE_VALKEY_ADDR: input.valkeyAddr } : {}),
    SUPATYPE_MANAGED_PROJECT_REF: input.projectRef,
    SUPATYPE_MANIFEST_PATH: input.manifestPath,
    SUPATYPE_ADMIN_CONFIG_PATH: input.adminConfigPath,
    SUPATYPE_POSTGREST_URL: `http://127.0.0.1:${input.postgrestPort}`,
    SUPATYPE_DB_PUBLIC_URL: splitPassword(input.databaseUrl).dsn,
    // A clear 501 on /graphql/v1 rather than "function not found" from PostgREST.
    ...nativeGraphqlServerEnv(input.pgBinDir),
  }
}

/**
 * The schema half of PostgREST's environment on the native path.
 *
 * The installed archive decides the tier: one downloaded before the masking library was bundled
 * has no extension, so its field rules are enforced by views instead. A versioned model adds the
 * generated `draft` schema, or `.draft()` would answer PGRST106 against a stack that had migrated
 * the views into place.
 */
export function nativePostgrestSchemaEnv(
  cwd: string,
  config: SupatypeProjectConfig,
  pgBinDir: string | null,
): ReturnType<typeof postgrestSchemaEnv> {
  return postgrestSchemaEnv(config, {
    tier: fieldMaskingTierFromProject(cwd, config, nativeMaskLibraryPresent(pgBinDir)),
    drafts: projectHasVersionedModels(cwd, config),
  })
}

/** The roles script for a new native database, with the mask extension only when the install has it. */
export function nativeDevRolesSql(pgBinDir: string | null): string {
  return nativeRolesSql(nativeMaskLibraryPresent(pgBinDir))
}
