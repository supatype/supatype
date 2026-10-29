// ─── Admin panel CLI commands (Gap Appendices task 48) ──────────────────────
//
// `npx supatype admin create-user`, create an admin user in the project's
// auth.users table. First admin is ensured on `supatype dev` or `supatype push`.

import type { Command } from "commander"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import bcrypt from "bcryptjs"
import type { Pool } from "pg"
import { isNumber, isShape, isString, isUnknown } from "@supatype/shared"
import { loadConfig } from "../config.js"
import { queryRows, type RowQueryable, type UnknownRow } from "../db-rows.js"
import { resolveRuntimeProvider, usesExternalDatabase, type SupatypeProjectConfig } from "../project-config.js"
import { resolveHostDatabaseUrl } from "../host-database.js"
import { projectStudioUrl } from "../local-stack.js"
import { STUDIO_ROLES } from "../studio-roles.js"
import { readEnvValue, upsertEnvFile } from "../env-file.js"
import { devDatabaseIdentity } from "../local-secrets.js"
import { composeDbPsql, type ComposeStack } from "../compose-db-psql.js"
import { hasEngineOverride } from "../binary-cache.js"
import { readDevSessionLock } from "../dev-session-lock.js"
import { composeProjectName } from "../self-host-compose.js"
import { confirm as uiConfirm } from "../ui/confirm.js"
import { adminPromptDeclined, recordAdminPromptDeclined } from "../admin-prompt-state.js"
import { error, info, plain } from "../ui/messages.js"
import { promptPassword, promptText } from "../ui/prompts.js"
import { isInteractive } from "../ui/interactive.js"
import { errorMessage } from "../error-message.js"
import {
  getActiveDevSession,
} from "../dev-session.js"

export const ADMIN_EMAIL_ENV = "SUPATYPE_ADMIN_EMAIL"
export const ADMIN_PASSWORD_ENV = "SUPATYPE_ADMIN_PASSWORD"

const BCRYPT_ROUNDS = 10

// Studio roles a membership row may hold. An unvalidated `--role` would create a
// user locked out of the very panel they were made for (see studio-roles.ts).
export { STUDIO_ROLES }

function assertStudioRole(role: string): void {
  if ((STUDIO_ROLES as readonly string[]).includes(role)) return
  error(
    `Unknown Studio role "${role}". Choose one of: ${STUDIO_ROLES.join(", ")}.\n` +
      "  Studio roles are Supatype's own; your application's roles are separate " +
      "and belong in your access rules.",
  )
  process.exit(1)
}

/** The auth service scopes users to the nil instance id in single-tenant/self-host mode. */
export const SUPATYPE_NIL_INSTANCE_ID = "00000000-0000-0000-0000-000000000000"

/** Audience claim used when looking up users (matches SUPATYPE_JWT_AUD in compose). */
export function authJwtAud(cwd: string): string {
  return readEnvValue(cwd, "SUPATYPE_JWT_AUD", "authenticated")
}

type DbQuery = (sql: string, params?: unknown[]) => Promise<{ rows: UnknownRow[] }>
type AuthConfirmedColumn = "email_confirmed_at" | "confirmed_at"

/** `db` as a `DbQuery`, its rows checked to be rows. */
function rowsQuery(db: RowQueryable): DbQuery {
  return async (sql, params) => ({ rows: await queryRows(db, sql, params) })
}

const hasUserId = isShape({ id: isString })

/** The user id in the first row, or a throw naming the statement that should have returned it. */
function firstUserId(rows: UnknownRow[], what: string): string {
  const row = rows[0]
  if (!hasUserId(row)) throw new Error(`${what} did not return the user's id`)
  return row.id
}

/** Prefer the migrated column when present; fall back to postgres init `confirmed_at`. */
export async function resolveAuthConfirmedAtColumn(query: DbQuery): Promise<AuthConfirmedColumn> {
  const result = await query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'auth'
       AND table_name = 'users'
       AND column_name IN ('email_confirmed_at', 'confirmed_at')
     ORDER BY CASE column_name WHEN 'email_confirmed_at' THEN 0 ELSE 1 END
     LIMIT 1`,
  )
  const row = result.rows[0]
  const name = row?.["column_name"] ?? row?.["value"]
  if (name === "email_confirmed_at" || name === "confirmed_at") return name
  return "confirmed_at"
}

export interface EnsureFirstAdminOptions {
  email?: string
  password?: string
  cwd?: string
  role?: string
  connection?: string
  compose?: ComposeStack
  /** Studio on the stack the admin was made for, named in the "log in" line when known. */
  studioUrl?: string | undefined
}

/**
 * Where to log in once an admin exists. Studio is served at `/studio/`; this used to say
 * `/admin`, which nothing serves (M3).
 */
export function studioLoginHint(studioUrl: string | undefined): string {
  return studioUrl === undefined
    ? "Log in to Studio at /studio/ on the project's API URL once the stack is running."
    : `Log in to Studio at ${studioUrl}`
}

function resolveAdminConnection(
  cwd: string,
  config: SupatypeProjectConfig,
  override?: string,
): string {
  return resolveHostDatabaseUrl(cwd, config, { connection: override, allowDerived: true }).dsn
}

export function registerAdmin(program: Command): void {
  const adminCmd = program
    .command("admin")
    .description("Manage admin panel users and configuration")

  adminCmd
    .command("create-user")
    .description("Create an admin user for the admin panel")
    .option("--email <email>", "Admin user email address")
    .option("--password <password>", "Admin user password (prompted if not provided)")
    .option("--role <role>", `Studio role to assign (${STUDIO_ROLES.join(" | ")})`, "admin")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(
      async (opts: {
        email?: string
        password?: string
        role: string
        connection?: string
      }) => {
        const cwd = process.cwd()
        const config = loadConfig(cwd)
        const connection = resolveAdminConnection(cwd, config, opts.connection)

        const email = opts.email ?? (await promptText("Admin email"))
        if (!email || !email.includes("@")) {
          error("A valid email address is required.")
          process.exit(1)
        }

        const password =
          opts.password ?? (await promptText("Admin password (min 8 chars)"))
        if (!password || password.length < 8) {
          error("Password must be at least 8 characters.")
          process.exit(1)
        }

        const role = opts.role
        assertStudioRole(role)

        info(`Creating admin user: ${email} (role: ${role})...`)

        const compose =
          opts.connection === undefined ? resolveDockerComposeContext(cwd, config) : null

        try {
          if (compose) {
            await createAdminUser(
              (sql, params) => composeExecQuery(cwd, compose, sql, params),
              email,
              password,
              role,
              { cwd },
            )
          } else {
            const pg = await importPg()
            const pool = new pg.Pool({ connectionString: connection, max: 2 })
            try {
              await ensureAuthUsersTable(pool)
              await createAdminUser(rowsQuery(pool), email, password, role, { cwd })
            } finally {
              await pool.end()
            }
          }
          info(studioLoginHint(projectStudioUrl(cwd, config, opts.connection)))
        } catch (err) {
          error(`Failed to create admin user: ${errorMessage(err)}`)
          process.exit(1)
        }
      },
    )

  adminCmd
    .command("set-role")
    .description("Change an existing user's admin role")
    .requiredOption("--email <email>", "User email address")
    .requiredOption("--role <role>", `New Studio role (${STUDIO_ROLES.join(" | ")})`)
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(
      async (opts: { email: string; role: string; connection?: string }) => {
        assertStudioRole(opts.role)
        const cwd = process.cwd()
        const config = loadConfig(cwd)
        const connection = resolveAdminConnection(cwd, config, opts.connection)

        const pg = await importPg()
        const pool = new pg.Pool({ connectionString: connection, max: 2 })

        try {
          const rows = await setStudioRole(rowsQuery(pool), opts.email, opts.role)

          if (rows.length === 0) {
            error(`No user found with email "${opts.email}".`)
            process.exit(1)
          }

          const userId = firstUserId(rows, "The role update")
          info("Role updated successfully.")
          plain(`  ID:    ${userId}`)
          plain(`  Email: ${opts.email.toLowerCase()}`)
          plain(`  Role:  ${opts.role}`)
        } catch (err) {
          error(`Failed to update role: ${errorMessage(err)}`)
          process.exit(1)
        } finally {
          await pool.end()
        }
      },
    )

  adminCmd
    .command("list-users")
    .description("List users with Studio access")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { connection?: string }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const connection = resolveAdminConnection(cwd, config, opts.connection)

      const pg = await importPg()
      const pool = new pg.Pool({ connectionString: connection, max: 2 })

      try {
        // Studio access is membership, not a claim, list the grant that
        // actually decides admission. LEFT JOIN, because a membership held by a
        // Supatype Cloud account has no row in this project's `auth.users`;
        // hiding those would make `list-users` disagree with who can log in.
        const rows = await queryRows(
          pool,
          `SELECT COALESCE(m.user_id, m.platform_user_id) AS id,
                  COALESCE(u.email, '(cloud account)') AS email,
                  m.role, m.created_at
             FROM _supatype.studio_members m
             LEFT JOIN auth.users u ON u.id = m.user_id
            ORDER BY m.created_at ASC`,
        )

        if (rows.length === 0) {
          info("No admin users found.")
          info("Create one with: supatype admin create-user --email admin@example.com --role admin")
          return
        }

        plain(
          "\n  ID                                     Email                          Role         Created",
        )
        plain("  " + "-".repeat(100))
        for (const row of rows) plain(memberLine(row))
        plain()
      } catch (err) {
        error(`Failed to list admin users: ${errorMessage(err)}`)
        process.exit(1)
      } finally {
        await pool.end()
      }
    })
}

const isMemberRow = isShape({ id: isString, email: isString, role: isString, created_at: isUnknown })

/** One `list-users` line: id, email, role and the date access was granted. */
function memberLine(row: UnknownRow): string {
  if (!isMemberRow(row)) throw new Error("A Studio membership row is missing its id, email or role")
  const created = row.created_at
  const date =
    created instanceof Date || typeof created === "string" ? new Date(created).toISOString().slice(0, 10) : "?"
  return `  ${row.id}  ${row.email.padEnd(30)} ${row.role.padEnd(12)} ${date}`
}

/** @deprecated Use ensureFirstAdminUser */
export const promptFirstAdminUser = ensureFirstAdminUser

/**
 * Ensure a first admin user exists (idempotent). Called from `dev` and `push`
 * when auth.users is ready and no admin users exist yet.
 */
export async function ensureFirstAdminUser(
  connection: string,
  options: EnsureFirstAdminOptions = {},
): Promise<void> {
  const pg = await importPg()
  const pool = new pg.Pool({ connectionString: connection, max: 2 })
  try {
    await ensureFirstAdminWithQuery(rowsQuery(pool), options)
  } catch {
    // Non-fatal: skip when DB is unreachable or auth schema is not ready
  } finally {
    await pool.end()
  }
}

/**
 * Resolve DB access for the current project (host URL or compose exec when DB
 * is not published to the host).
 */
export async function ensureFirstAdminUserForProject(
  cwd: string,
  config: SupatypeProjectConfig,
  options: EnsureFirstAdminOptions = {},
): Promise<void> {
  const root = resolve(cwd)
  const merged: EnsureFirstAdminOptions = {
    cwd: root,
    ...options,
    studioUrl: options.studioUrl ?? projectStudioUrl(root, config, options.connection),
  }

  if (writesAdminThroughCompose(config, merged) && merged.compose) {
    try {
      await ensureFirstAdminWithQuery(
        (sql, params) => composeExecQuery(root, merged.compose!, sql, params),
        merged,
      )
    } catch (err) {
      error(`Could not ensure first admin user: ${errorMessage(err)}`)
    }
    return
  }

  const connection = resolveHostDatabaseUrl(root, config, {
    connection: options.connection,
    allowDerived: true,
  }).dsn

  await ensureFirstAdminUser(connection, merged)
}

/**
 * Whether the first admin is written by exec'ing psql in the compose `db` container.
 *
 * Only when there is one. An external database has no `db` service, so the exec failed with
 * "service \"db\" is not running" and a BYO project got no admin; its URL reaches the database.
 */
export function writesAdminThroughCompose(
  config: SupatypeProjectConfig,
  options: Pick<EnsureFirstAdminOptions, "compose">,
): boolean {
  return (
    resolveRuntimeProvider(config) === "docker" &&
    options.compose !== undefined &&
    !hasEngineOverride(config) &&
    !usesExternalDatabase(config)
  )
}

/** Exported for tests: the DB seam both the pool and compose paths share. */
export async function ensureFirstAdminWithQuery(
  query: DbQuery,
  options: EnsureFirstAdminOptions,
): Promise<void> {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd()

  if (!(await authUsersTableExists(query))) return
  if (await hasAdminUsers(query)) return

  const credentials = await resolveAdminCredentials(options, cwd)
  if (!credentials) {
    if (!isInteractive()) info(missingAdminCredentialsHint(cwd, options))
    return
  }

  const role = options.role ?? "admin"
  try {
    await createAdminUser(query, credentials.email, credentials.password, role, {
      quiet: true,
      cwd,
    })
  } catch (err) {
    error(`Failed to create admin user: ${errorMessage(err)}`)
    return
  }
  clearAdminSeedPassword(cwd)
  logFirstAdminCreated(credentials.email, role, options.studioUrl)
}

function logFirstAdminCreated(email: string, role: string, studioUrl: string | undefined): void {
  const say = getActiveDevSession()?.isTui() ? (line: string) => console.log(line) : info
  say(`Admin user "${email}" created (role: ${role}).`)
  say(studioLoginHint(studioUrl))
}

/**
 * What to say when there is no admin and no credentials to make one with.
 *
 * Naming both variables is wrong in the common case. `clearAdminSeedPassword` retires the seed
 * password once it has been used, so a project that has ever created an admin keeps the email and
 * has no password, and a later run against a reset database then reports both as missing. That
 * reads as "you never set these" when in fact this tool consumed one of them, which is a dead end
 * for anyone who knows they set it.
 */
function missingAdminCredentialsHint(cwd: string, options: EnsureFirstAdminOptions): string {
  const email = options.email ?? readEnvValue(cwd, ADMIN_EMAIL_ENV, "").trim()
  const create = "or run: supatype admin create-user"
  if (!email) {
    return `No admin users found. Set ${ADMIN_EMAIL_ENV} / ${ADMIN_PASSWORD_ENV} in .env, ${create}`
  }
  return (
    `No admin users found. .env has ${ADMIN_EMAIL_ENV}="${email}" but no ${ADMIN_PASSWORD_ENV}: ` +
    `it is a one-time seed and is removed once an admin has been created. ` +
    `Set ${ADMIN_PASSWORD_ENV} again to seed one, ${create}`
  )
}

async function resolveAdminCredentials(
  options: EnsureFirstAdminOptions,
  cwd: string,
): Promise<{ email: string; password: string } | null> {
  const envEmail = options.email ?? readEnvValue(cwd, ADMIN_EMAIL_ENV, "").trim()
  const envPassword =
    options.password ?? readEnvValue(cwd, ADMIN_PASSWORD_ENV, "").trim()

  if (envEmail && envPassword) {
    if (!envEmail.includes("@")) {
      info("Invalid admin email in .env. Skipping admin user creation.")
      return null
    }
    if (envPassword.length < 8) {
      info("Admin password in .env is too short (min 8 chars). Skipping.")
      return null
    }
    return { email: envEmail, password: envPassword }
  }

  if (!isInteractive()) return null
  // Asked once per project: a "no" is kept, so later starts neither ask nor wait.
  if (adminPromptDeclined(cwd)) return null

  info("No admin users found for the admin panel.")
  const createAdmin = await uiConfirm("Create an admin user now?")
  if (!createAdmin) {
    recordAdminPromptDeclined(cwd)
    info("Skipped, and not asked again for this project. Create one with: supatype admin create-user")
    return null
  }

  const email = await promptText("Admin email")
  if (!email || !email.includes("@")) {
    info("Invalid email. Skipping admin user creation.")
    return null
  }

  const password = await promptPassword("Admin password (min 8 chars)")
  if (!password || password.length < 8) {
    info("Password too short. Skipping admin user creation.")
    return null
  }

  return { email, password }
}

export function clearAdminSeedPassword(cwd: string): void {
  // Unconditional: this is a one-time seed password being retired, and whoever wrote it wanted it
  // gone once used.
  upsertEnvFile(cwd, {}, { remove: [ADMIN_PASSWORD_ENV] })
}

export async function hashPasswordForAuth(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

async function createAdminUser(
  query: DbQuery,
  email: string,
  password: string,
  role: string,
  opts: { quiet?: boolean; aud?: string; cwd?: string } = {},
): Promise<void> {
  const normalized = email.toLowerCase()
  const aud = opts.aud ?? (opts.cwd ? authJwtAud(opts.cwd) : "authenticated")
  const existing = await query(
    `SELECT id FROM auth.users
     WHERE instance_id = $1::uuid
       AND LOWER(email) = $2
       AND aud = $3
       AND is_sso_user = false`,
    [SUPATYPE_NIL_INSTANCE_ID, normalized, aud],
  )
  if (existing.rows.length > 0) {
    throw new Error(`User with email "${email}" already exists.`)
  }

  const userId = await insertAuthUser(query, normalized, aud, await hashPasswordForAuth(password))
  await recordStudioMembership(query, userId, role)
  if (!opts.quiet) {
    info("Admin user created successfully.")
    plain(`  ID:    ${userId}`)
    plain(`  Email: ${normalized}`)
    plain(`  Role:  ${role}`)
  }
}

/** Insert the user into `auth.users` and return its new id. */
async function insertAuthUser(query: DbQuery, email: string, aud: string, passwordHash: string): Promise<string> {
  // No `role` here: `app_metadata` is the developer's namespace for their own
  // application roles, and Studio access is granted through
  // `_supatype.studio_members` instead. Writing it in both places means an app
  // role assignment can silently confer admin UI access.
  const appMetadata = JSON.stringify({ provider: "email", providers: ["email"] })
  const confirmedCol = await resolveAuthConfirmedAtColumn(query)
  const result = await query(
    `INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      raw_app_meta_data, raw_user_meta_data,
      ${confirmedCol},
      confirmation_token, recovery_token,
      email_change_token_new, email_change, email_change_token_current,
      phone_change, phone_change_token, reauthentication_token,
      is_sso_user, is_anonymous,
      created_at, updated_at
    ) VALUES (
      $1::uuid, gen_random_uuid(), $2, 'authenticated', $3, $4,
      $5::jsonb, $6::jsonb,
      now(),
      '', '', '', '', '', '', '', '',
      false, false,
      now(), now()
    ) RETURNING id, email`,
    [SUPATYPE_NIL_INSTANCE_ID, aud, email, passwordHash, appMetadata, JSON.stringify({})],
  )
  return firstUserId(result.rows, "Creating the user")
}

/**
 * Record Studio access in `_supatype.studio_members`.
 *
 * Studio capability is deliberately not a JWT claim: `app_metadata` belongs to
 * the developer's own app roles, and letting it grant Studio access means a
 * developer assigning an app role could hand out admin UI access by accident.
 *
 * This is now the *only* grant, so a failure here is fatal to the command, a
 * user created without a membership row cannot reach Studio at all, and
 * reporting success would leave no clue why.
 */
export async function recordStudioMembership(
  query: DbQuery,
  userId: string,
  role: string,
): Promise<void> {
  await ensureStudioMembersTable(query)
  await query(
    `WITH ${CLI_MARK}
     INSERT INTO _supatype.studio_members (user_id, role)
     SELECT $1::uuid, $2::text FROM cli_mark
     ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
    [userId, role],
  )
}

/**
 * Give the user with `email` the Studio role `role`, returning their `id` and
 * `email`, or no row when there is no such user.
 *
 * Studio roles live in `_supatype.studio_members`, not in `app_metadata`: that
 * key is the developer's namespace for their own app roles, and writing Studio
 * access there means assigning an app role could hand out admin UI access by
 * accident.
 */
export async function setStudioRole(query: DbQuery, email: string, role: string): Promise<UnknownRow[]> {
  await ensureStudioMembersTable(query)
  const result = await query(
    `WITH ${CLI_MARK}, target AS (
       SELECT id, email FROM auth.users WHERE email = $2
     ), upsert AS (
       INSERT INTO _supatype.studio_members (user_id, role)
       SELECT target.id, $1 FROM target CROSS JOIN cli_mark
       ON CONFLICT (user_id) DO UPDATE
         SET role = EXCLUDED.role, updated_at = now()
       RETURNING user_id
     )
     SELECT id, email FROM target`,
    [role, email.toLowerCase()],
  )
  return result.rows
}

/**
 * The source the CLI marks its membership writes with. The engine's audit
 * trigger records the transaction's `supatype.membership_api` setting as the
 * change's source, and Studio trusts `cli`, so an admin made or changed here is
 * not flagged as changed outside Studio, while a raw `UPDATE` still is.
 */
export const CLI_MEMBERSHIP_SOURCE = "cli"

/**
 * The CTE a membership write reads its rows through, so the mark is set in the
 * statement that writes, before the trigger fires at its end. Transaction-local:
 * each of these statements is its own transaction, and the mark ends with it.
 */
const CLI_MARK = `cli_mark AS (
       SELECT set_config('supatype.membership_api', '${CLI_MEMBERSHIP_SOURCE}', true) AS source
     )`

async function ensureAuthUsersTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS auth;

    CREATE TABLE IF NOT EXISTS auth.users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id   UUID DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
      aud           TEXT DEFAULT 'authenticated',
      role          TEXT DEFAULT 'authenticated',
      email         TEXT UNIQUE,
      encrypted_password TEXT,
      email_confirmed_at TIMESTAMPTZ DEFAULT now(),
      raw_app_meta_data  JSONB DEFAULT '{}',
      raw_user_meta_data JSONB DEFAULT '{}',
      created_at    TIMESTAMPTZ DEFAULT now(),
      updated_at    TIMESTAMPTZ DEFAULT now(),
      confirmation_token TEXT DEFAULT '',
      recovery_token TEXT DEFAULT '',
      email_change_token_new TEXT DEFAULT '',
      email_change_token_current TEXT DEFAULT '',
      email_change  TEXT DEFAULT '',
      phone_change  TEXT DEFAULT '',
      phone_change_token TEXT DEFAULT '',
      reauthentication_token TEXT DEFAULT '',
      is_sso_user   BOOLEAN NOT NULL DEFAULT false,
      is_anonymous  BOOLEAN NOT NULL DEFAULT false
    );
  `)
}

async function authUsersTableExists(query: DbQuery): Promise<boolean> {
  const result = await query(
    `SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'auth' AND table_name = 'users'
    ) as exists`,
  )
  return Boolean(result.rows[0]?.exists)
}

/**
 * Whether anyone can already reach Studio.
 *
 * Counts membership rows, not `app_metadata` claims: the claim no longer grants
 * anything, so counting it would report an admin exists while nobody can log in.
 * A missing table means the project has never been pushed, no admins.
 */
async function hasAdminUsers(query: DbQuery): Promise<boolean> {
  // Postgres resolves relations at parse time, so the table has to be checked
  // separately rather than guarded inside the count query. Absent means the
  // project has never been pushed, no admins, and `createAdminUser` will
  // create the table itself.
  if (!(await studioMembersTableExists(query))) return false

  // Inner JOIN on purpose, unlike `list-users`: a membership held by a cloud
  // account cannot log in to a self-hosted auth service, so a project exported from
  // cloud with only those grants genuinely still needs a first admin.
  const adminCount = await query(
    `SELECT COUNT(*)::int as count
       FROM _supatype.studio_members m
       JOIN auth.users u ON u.id = m.user_id
      WHERE m.role <> 'authenticated'`,
  )
  const count = adminCount.rows[0]?.["count"]
  return isNumber(count) && count > 0
}

/**
 * A project whose engine predates the membership table, or one that has never
 * been pushed, still needs working `admin create-user` / `admin set-role`.
 * Mirrors the engine's own definition (`create_studio_members_table_sql`).
 *
 * A row is held by exactly one identity: `user_id` for a project user (what the
 * CLI grants), or `platform_user_id` for a Supatype Cloud account. The engine
 * migrates older single-identity tables; this only has to create the current
 * shape when there is nothing there at all.
 */
async function ensureStudioMembersTable(query: DbQuery): Promise<void> {
  await query(`CREATE SCHEMA IF NOT EXISTS _supatype`)
  await query(
    `CREATE TABLE IF NOT EXISTS _supatype.studio_members (
       id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id           UUID UNIQUE,
       platform_user_id  UUID UNIQUE,
       role              TEXT NOT NULL,
       created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       CONSTRAINT studio_members_one_identity
         CHECK (num_nonnulls(user_id, platform_user_id) = 1)
     )`,
  )
}

async function studioMembersTableExists(query: DbQuery): Promise<boolean> {
  const result = await query(
    `SELECT to_regclass('_supatype.studio_members') IS NOT NULL as exists`,
  )
  return Boolean(result.rows[0]?.exists)
}

/** Postgres password for compose `exec psql` (db is not published to the host). */
export function composePostgresPassword(cwd: string): string {
  return devDatabaseIdentity(cwd).password
}

function resolveDockerComposeContext(
  cwd: string,
  config: SupatypeProjectConfig,
): ComposeStack | null {
  if (resolveRuntimeProvider(config) !== "docker" || hasEngineOverride(config)) {
    return null
  }

  const session = readDevSessionLock(cwd)
  if (session?.composeProject && session.composePath && existsSync(session.composePath)) {
    return { project: session.composeProject, composePath: session.composePath }
  }

  const composePath = resolve(cwd, ".supatype/self-host/docker-compose.yml")
  if (!existsSync(composePath)) return null

  return {
    project: composeProjectName(config.project?.name ?? "project"),
    composePath,
  }
}

async function composeExecQuery(
  cwd: string,
  compose: ComposeStack,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: UnknownRow[] }> {
  if (params.length === 0) {
    const text = runComposePsql(cwd, compose, ["-tAc", sql])
    if (sql.trim().toUpperCase().startsWith("SELECT")) {
      return { rows: parsePsqlScalarRows(sql, text) }
    }
    return { rows: [] }
  }

  // On stdin: the values include the new user's password hash, which has no place on docker's
  // command line.
  const stdout = runComposePsql(cwd, compose, ["-v", "ON_ERROR_STOP=1", "-f", "-"], interpolateSql(sql, params))
  const idMatch = stdout.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+\|\s+(.+)/i,
  )
  if (idMatch) {
    return { rows: [{ id: idMatch[1], email: idMatch[2]?.trim() }] }
  }
  return { rows: [] }
}

/**
 * Run `psql` in the stack's `db` container as the project's database owner, with `input` on its
 * stdin, and return its trimmed stdout.
 */
function runComposePsql(cwd: string, compose: ComposeStack, psqlArgs: string[], input?: string): string {
  const { args, env } = composeDbPsql(cwd, compose, psqlArgs)
  const result = spawnSync("docker", args, {
    cwd: dirname(compose.composePath),
    encoding: "utf8",
    env,
    ...(input !== undefined && { input }),
  })
  if (result.status !== 0) {
    throw new Error((result.stderr ?? result.stdout ?? "compose psql failed").trim())
  }
  return (result.stdout ?? "").trim()
}

function parsePsqlScalarRows(sql: string, text: string): UnknownRow[] {
  const upper = sql.toUpperCase()
  if (upper.includes(" AS EXISTS")) {
    return [{ exists: text === "t" }]
  }
  if (upper.includes(" AS COUNT")) {
    return [{ count: Number.parseInt(text, 10) || 0 }]
  }
  if (text === "") return []
  return [{ value: text }]
}

function interpolateSql(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_match, index: string) => {
    const value = params[Number(index) - 1]
    if (value === null || value === undefined) return "NULL"
    if (typeof value === "number" || typeof value === "bigint") return String(value)
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
    return `'${String(value).replace(/'/g, "''")}'`
  })
}

async function importPg(): Promise<typeof import("pg")> {
  try {
    return await import("pg")
  } catch {
    error("pg package is required for admin commands. Install it with: pnpm add pg")
    process.exit(1)
  }
}
