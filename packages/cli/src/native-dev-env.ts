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
import { nativeMailerAutoconfirmEnv } from "./mailer-autoconfirm.js"
import { mailerProviderEnv, mailerUrlPathsEnv, withoutBlankMailerOverrides } from "./mailer-env.js"
import { projectHasVersionedModels } from "./model-versioning.js"
import { nativeRolesSql } from "./native-roles-sql.js"
import { nativeGraphqlServerEnv, nativeMaskLibraryPresent } from "./postgres-ctl.js"
import { DENO_PORT_ENV, postgrestSchemaEnv, type SupatypeProjectConfig } from "./project-config.js"

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
 * What every Deno the CLI or compose starts is given: no colour. Deno colours the text of an error,
 * a missing module's location among it, whether or not it writes to a terminal, and a function's
 * error reaches its caller as JSON. The routers still strip escape codes, for a Deno started some
 * other way. The compose worker's template says the same in YAML (self-host-compose.ts).
 */
export const DENO_ENV = { NO_COLOR: "1" } as const

/**
 * supatype-server's outer layer: mode, cache, manifest paths, PostgREST and GraphQL, and the
 * database as this machine reaches it, without its password, for Studio's connection strings. The
 * server passes its environment to the Deno child that runs functions, so {@link DENO_ENV} too.
 */
export function nativeServerCoreEnv(input: NativeServerCoreInput): Record<string, string> {
  return {
    ...DENO_ENV,
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

/** The send-email hook's signing secret in native dev, in the server's symmetric format. Override via .env. */
const LOCAL_SEND_EMAIL_HOOK_SECRETS = "v1,whsec_abcdefghijklmnopqrstuvwxyz01234567"

/** `email.send_email_hook` as the server's hook settings, aimed at this server unless the config names a target. */
function nativeSendEmailHookEnv(email: SupatypeProjectConfig["email"], serverPort: string): Record<string, string> {
  if (email?.send_email_hook !== true) return {}
  return {
    SUPATYPE_HOOK_SEND_EMAIL_ENABLED: "true",
    SUPATYPE_HOOK_SEND_EMAIL_URI:
      email.send_email_hook_uri?.trim() || `http://127.0.0.1:${serverPort}/internal/v0hooks/send-email`,
    SUPATYPE_HOOK_SEND_EMAIL_SECRETS: email.send_email_hook_secrets?.trim() || LOCAL_SEND_EMAIL_HOOK_SECRETS,
  }
}

/**
 * The auth server's external URL and mailer on the native path, where the server is the gateway
 * and the auth routes sit under `/auth/v1`. The verify paths are what make emailed links land
 * there: without them the server's default `/verify` resolved to the origin's root, a 404.
 */
export function nativeAuthMailerEnv(email: SupatypeProjectConfig["email"], serverPort: string): Record<string, string> {
  return {
    SUPATYPE_API_EXTERNAL_URL: `http://localhost:${serverPort}/auth/v1`,
    ...mailerUrlPathsEnv(),
    ...mailerProviderEnv(email),
    ...nativeSendEmailHookEnv(email, serverPort),
  }
}

/** What {@link nativeServerDotEnvLayer} lays over the server's environment. */
export interface NativeDotEnvLayerInput {
  /** `.env` then `.env.local`, the later file winning. */
  dotEnv: Record<string, string>
  config: SupatypeProjectConfig
  cwd: string
  /** The Deno port dev checked was free. */
  denoPort: number
}

/** The last layer of supatype-server's environment on the native path: `.env` and what follows it. */
export function nativeServerDotEnvLayer({ dotEnv, config, cwd, denoPort }: NativeDotEnvLayerInput): Record<string, string> {
  return {
    // A blank mailer value init scaffolded into .env does not erase the config's.
    ...withoutBlankMailerOverrides(dotEnv, mailerProviderEnv(config.email)),
    // After .env: auth.email.enableConfirmations, unless the developer set their own value.
    ...nativeMailerAutoconfirmEnv(cwd, config),
    // Last, so the port dev checked is the port Deno gets: a value in .env or .env.local, blank
    // included, would otherwise replace it.
    [DENO_PORT_ENV]: String(denoPort),
  }
}
