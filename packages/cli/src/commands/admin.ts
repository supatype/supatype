// ─── Admin panel CLI commands (Gap Appendices task 48) ──────────────────────
//
// `npx supatype admin create-user` — create an admin user in the project's
// auth.users table. First admin is ensured on `supatype dev` or `supatype push`.

import type { Command } from "commander"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import bcrypt from "bcryptjs"
import type { Pool, QueryResult } from "pg"
import { loadConfig } from "../config.js"
import {
  connectionString,
  resolveRuntimeProvider,
  type SupatypeProjectConfig,
} from "../project-config.js"
import { readEnvValue, upsertEnvFile } from "../env-file.js"
import { hasEngineOverride } from "../binary-cache.js"
import { readDevSessionLock } from "../dev-session-lock.js"
import { composeProjectName } from "../self-host-compose.js"
import { confirm as uiConfirm } from "../ui/confirm.js"
import { error, info, plain } from "../ui/messages.js"
import { promptPassword, promptText } from "../ui/prompts.js"
import { isInteractive } from "../ui/interactive.js"
import {
  getActiveDevSession,
} from "../dev-session.js"

export const ADMIN_EMAIL_ENV = "SUPATYPE_ADMIN_EMAIL"
export const ADMIN_PASSWORD_ENV = "SUPATYPE_ADMIN_PASSWORD"

const BCRYPT_ROUNDS = 10

/** GoTrue scopes users to the nil instance id in single-tenant/self-host mode. */
export const GOTRUE_NIL_INSTANCE_ID = "00000000-0000-0000-0000-000000000000"

/** Audience claim used by GoTrue when looking up users (matches GOTRUE_JWT_AUD in compose). */
export function gotrueJwtAud(cwd: string): string {
  return readEnvValue(cwd, "GOTRUE_JWT_AUD", "authenticated")
}

type DbQuery = (sql: string, params?: unknown[]) => Promise<QueryResult>
type AuthConfirmedColumn = "email_confirmed_at" | "confirmed_at"

/** Prefer GoTrue's column when migrated; fall back to postgres init `confirmed_at`. */
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
  const row = result.rows[0] as { column_name?: string; value?: string } | undefined
  const name = row?.column_name ?? row?.value
  if (name === "email_confirmed_at" || name === "confirmed_at") return name
  return "confirmed_at"
}

export interface EnsureFirstAdminOptions {
  email?: string
  password?: string
  cwd?: string
  role?: string
  connection?: string
  compose?: { project: string; composePath: string }
}

function resolveAdminConnection(
  cwd: string,
  config: SupatypeProjectConfig,
  override?: string,
): string {
  if (override !== undefined) return override
  if (hasEngineOverride(config)) return hostComposeDbUrlFromEnv(cwd)
  return readEnvValue(cwd, "DATABASE_URL", connectionString(config))
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
    .option("--role <role>", "Admin role to assign", "admin")
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
              await createAdminUser(pool, email, password, role, { cwd })
            } finally {
              await pool.end()
            }
          }
          info("This user can now log in to the admin panel at /admin")
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error"
          error(`Failed to create admin user: ${message}`)
          process.exit(1)
        }
      },
    )

  adminCmd
    .command("set-role")
    .description("Change an existing user's admin role")
    .requiredOption("--email <email>", "User email address")
    .requiredOption("--role <role>", "New role to assign")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(
      async (opts: { email: string; role: string; connection?: string }) => {
        const cwd = process.cwd()
        const config = loadConfig(cwd)
        const connection = resolveAdminConnection(cwd, config, opts.connection)

        const pg = await importPg()
        const pool = new pg.Pool({ connectionString: connection, max: 2 })

        try {
          const result = await pool.query(
            `UPDATE auth.users
             SET raw_app_meta_data = raw_app_meta_data || $1::jsonb,
                 updated_at = now()
             WHERE email = $2
             RETURNING id, email, raw_app_meta_data`,
            [JSON.stringify({ role: opts.role }), opts.email.toLowerCase()],
          )

          if (result.rows.length === 0) {
            error(`No user found with email "${opts.email}".`)
            process.exit(1)
          }

          const user = result.rows[0] as {
            id: string
            email: string
            raw_app_meta_data: Record<string, unknown>
          }

          info("Role updated successfully.")
          plain(`  ID:    ${user.id}`)
          plain(`  Email: ${user.email}`)
          plain(`  Role:  ${opts.role}`)
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Unknown error"
          error(`Failed to update role: ${message}`)
          process.exit(1)
        } finally {
          await pool.end()
        }
      },
    )

  adminCmd
    .command("list-users")
    .description("List users with admin roles")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { connection?: string }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const connection = resolveAdminConnection(cwd, config, opts.connection)

      const pg = await importPg()
      const pool = new pg.Pool({ connectionString: connection, max: 2 })

      try {
        const result = await pool.query(
          `SELECT id, email, raw_app_meta_data->>'role' as role, created_at
           FROM auth.users
           WHERE raw_app_meta_data->>'role' IS NOT NULL
             AND raw_app_meta_data->>'role' != 'authenticated'
           ORDER BY created_at ASC`,
        )

        if (result.rows.length === 0) {
          info("No admin users found.")
          info("Create one with: supatype admin create-user --email admin@example.com --role admin")
          return
        }

        plain(
          "\n  ID                                     Email                          Role         Created",
        )
        plain("  " + "-".repeat(100))
        for (const row of result.rows) {
          const r = row as {
            id: string
            email: string
            role: string
            created_at: string
          }
          const date = new Date(r.created_at).toISOString().slice(0, 10)
          plain(
            `  ${r.id}  ${r.email.padEnd(30)} ${r.role.padEnd(12)} ${date}`,
          )
        }
        plain()
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error"
        error(`Failed to list admin users: ${message}`)
        process.exit(1)
      } finally {
        await pool.end()
      }
    })
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
    await ensureFirstAdminWithQuery(
      (sql, params) => pool.query(sql, params),
      options,
    )
  } catch {
    // Non-fatal — skip when DB is unreachable or auth schema is not ready
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
  const merged: EnsureFirstAdminOptions = { cwd: root, ...options }

  if (
    resolveRuntimeProvider(config) === "docker" &&
    merged.compose &&
    !hasEngineOverride(config)
  ) {
    try {
      await ensureFirstAdminWithQuery(
        (sql, params) => composeExecQuery(root, merged.compose!, sql, params),
        merged,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      error(`Could not ensure first admin user: ${message}`)
    }
    return
  }

  const connection =
    merged.compose && hasEngineOverride(config)
      ? hostComposeDbUrlFromEnv(root)
      : options.connection ?? readEnvValue(root, "DATABASE_URL", connectionString(config))

  await ensureFirstAdminUser(connection, merged)
}

async function ensureFirstAdminWithQuery(
  query: DbQuery,
  options: EnsureFirstAdminOptions,
): Promise<void> {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd()

  if (!(await authUsersTableExists(query))) return
  if (await hasAdminUsers(query)) return

  const credentials = await resolveAdminCredentials(options, cwd)
  if (!credentials) {
    if (!isInteractive()) {
      info(
        "No admin users found. Set SUPATYPE_ADMIN_EMAIL / SUPATYPE_ADMIN_PASSWORD in .env, " +
          "or run: supatype admin create-user",
      )
    }
    return
  }

  const role = options.role ?? "admin"
  try {
    await createAdminUser(query, credentials.email, credentials.password, role, {
      quiet: true,
      cwd,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    error(`Failed to create admin user: ${message}`)
    return
  }
  clearAdminSeedPassword(cwd)
  logFirstAdminCreated(credentials.email, role)
}

function logFirstAdminCreated(email: string, role: string): void {
  if (getActiveDevSession()?.isTui()) {
    console.log(`Admin user "${email}" created (role: ${role}).`)
    console.log("Log in at /admin after starting the dev server.")
    return
  }
  info(`Admin user "${email}" created (role: ${role}).`)
  info("Log in at /admin after starting the dev server.")
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

  info("No admin users found for the admin panel.")
  const createAdmin = await uiConfirm("Create an admin user now?")
  if (!createAdmin) {
    info("Skipped. You can create one later with: supatype admin create-user")
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
  upsertEnvFile(cwd, {}, [ADMIN_PASSWORD_ENV])
}

export async function hashPasswordForAuth(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

async function createAdminUser(
  db: Pool | DbQuery,
  email: string,
  password: string,
  role: string,
  opts: { quiet?: boolean; aud?: string; cwd?: string } = {},
): Promise<{ id: string; email: string }> {
  const query: DbQuery =
    typeof (db as Pool).query === "function"
      ? (sql, params) => (db as Pool).query(sql, params)
      : (db as DbQuery)

  const normalized = email.toLowerCase()
  const aud = opts.aud ?? (opts.cwd ? gotrueJwtAud(opts.cwd) : "authenticated")
  const existing = await query(
    `SELECT id FROM auth.users
     WHERE instance_id = $1::uuid
       AND LOWER(email) = $2
       AND aud = $3
       AND is_sso_user = false`,
    [GOTRUE_NIL_INSTANCE_ID, normalized, aud],
  )
  if (existing.rows.length > 0) {
    throw new Error(`User with email "${email}" already exists.`)
  }

  const passwordHash = await hashPasswordForAuth(password)
  const appMetadata = JSON.stringify({
    role,
    provider: "email",
    providers: ["email"],
  })
  const userMetadata = JSON.stringify({})
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
    [GOTRUE_NIL_INSTANCE_ID, aud, normalized, passwordHash, appMetadata, userMetadata],
  )

  const user = result.rows[0] as { id: string; email: string }
  if (!opts.quiet) {
    info("Admin user created successfully.")
    plain(`  ID:    ${user.id}`)
    plain(`  Email: ${user.email}`)
    plain(`  Role:  ${role}`)
  }
  return user
}

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

async function hasAdminUsers(query: DbQuery): Promise<boolean> {
  const adminCount = await query(
    `SELECT COUNT(*)::int as count FROM auth.users
     WHERE raw_app_meta_data->>'role' IS NOT NULL
       AND raw_app_meta_data->>'role' != 'authenticated'`,
  )
  const count = (adminCount.rows[0] as { count: number } | undefined)?.count ?? 0
  return count > 0
}

/** Postgres password for compose `exec psql` (db is not published to the host). */
export function composePostgresPassword(cwd: string): string {
  return readEnvValue(cwd, "POSTGRES_PASSWORD", "postgres")
}

function resolveDockerComposeContext(
  cwd: string,
  config: SupatypeProjectConfig,
): { project: string; composePath: string } | null {
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

function composeExecQuery(
  cwd: string,
  compose: { project: string; composePath: string },
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult> {
  const db = readEnvValue(cwd, "POSTGRES_DB", "supatype")
  const user = readEnvValue(cwd, "POSTGRES_USER", "supatype_admin")
  const pgPassword = composePostgresPassword(cwd)
  const envFile = join(cwd, ".env")
  const composeDir = dirname(compose.composePath)
  const args = [
    "compose",
    "-p",
    compose.project,
    "--project-directory",
    cwd,
    "-f",
    compose.composePath,
  ]
  if (existsSync(envFile)) args.push("--env-file", envFile)

  if (params.length === 0) {
    args.push(
      "exec",
      "-T",
      "-e",
      `PGPASSWORD=${pgPassword}`,
      "db",
      "psql",
      "-U",
      user,
      "-d",
      db,
      "-tAc",
      sql,
    )
    const result = spawnSync("docker", args, { cwd: composeDir, encoding: "utf8" })
    if (result.status !== 0) {
      throw new Error((result.stderr ?? result.stdout ?? "compose psql failed").trim())
    }
    const text = (result.stdout ?? "").trim()
    if (sql.trim().toUpperCase().startsWith("SELECT")) {
      return Promise.resolve({
        rows: parsePsqlScalarRows(sql, text),
        rowCount: 1,
        command: "SELECT",
        oid: 0,
        fields: [],
      })
    }
    return Promise.resolve({
      rows: [],
      rowCount: 0,
      command: "INSERT",
      oid: 0,
      fields: [],
    })
  }

  args.push(
    "exec",
    "-T",
    "-e",
    `PGPASSWORD=${pgPassword}`,
    "db",
    "psql",
    "-U",
    user,
    "-d",
    db,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    interpolateSql(sql, params),
  )
  const result = spawnSync("docker", args, { cwd: composeDir, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error((result.stderr ?? result.stdout ?? "compose psql failed").trim())
  }
  const stdout = (result.stdout ?? "").trim()
  const idMatch = stdout.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+\|\s+(.+)/i,
  )
  if (idMatch) {
    return Promise.resolve({
      rows: [{ id: idMatch[1], email: idMatch[2]?.trim() }],
      rowCount: 1,
      command: "INSERT",
      oid: 0,
      fields: [],
    })
  }
  return Promise.resolve({
    rows: [],
    rowCount: 0,
    command: "INSERT",
    oid: 0,
    fields: [],
  })
}

function parsePsqlScalarRows(sql: string, text: string): Record<string, unknown>[] {
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

function hostComposeDbUrlFromEnv(cwd: string): string {
  const port = readEnvValue(cwd, "SUPATYPE_DEV_DB_PORT", "54329")
  const user = readEnvValue(cwd, "POSTGRES_USER", "supatype_admin")
  const pass = readEnvValue(cwd, "POSTGRES_PASSWORD", "postgres")
  const db = readEnvValue(cwd, "POSTGRES_DB", "supatype")
  return `postgresql://${user}:${pass}@127.0.0.1:${port}/${db}?sslmode=disable`
}

async function importPg(): Promise<typeof import("pg")> {
  try {
    return await import("pg")
  } catch {
    error("pg package is required for admin commands. Install it with: pnpm add pg")
    process.exit(1)
  }
}
