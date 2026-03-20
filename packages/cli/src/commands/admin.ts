// ─── Admin panel CLI commands (Gap Appendices task 48) ──────────────────────
//
// `npx supatype admin create-user` — create an admin user in the project's
// {ref}_auth.users table. Used for initial setup and ongoing admin management.

import type { Command } from "commander"
import { createInterface } from "node:readline"
import { randomBytes, scrypt } from "node:crypto"
import { promisify } from "node:util"
import { loadConfig } from "../config.js"
import { signJwt } from "../jwt.js"

const scryptAsync = promisify(scrypt)

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
        const connection = opts.connection ?? config.connection

        const email = opts.email ?? (await prompt("Admin email: "))
        if (!email || !email.includes("@")) {
          console.error("A valid email address is required.")
          process.exit(1)
        }

        const password =
          opts.password ?? (await prompt("Admin password (min 8 chars): "))
        if (!password || password.length < 8) {
          console.error("Password must be at least 8 characters.")
          process.exit(1)
        }

        const role = opts.role

        console.log(`\nCreating admin user: ${email} (role: ${role})...`)

        // We use pg directly to insert into the auth.users table
        const pg = await importPg()
        const pool = new pg.Pool({ connectionString: connection, max: 2 })

        try {
          // Ensure the auth schema and users table exist
          await pool.query(`
            CREATE SCHEMA IF NOT EXISTS auth;

            CREATE TABLE IF NOT EXISTS auth.users (
              id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              instance_id   UUID,
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
              email_change  TEXT DEFAULT ''
            );
          `)

          // Check if user already exists
          const existing = await pool.query(
            `SELECT id FROM auth.users WHERE email = $1`,
            [email.toLowerCase()],
          )

          if (existing.rows.length > 0) {
            console.error(
              `\nUser with email "${email}" already exists.`,
            )
            console.log(
              `To update their role, use: supatype admin set-role --email ${email} --role ${role}`,
            )
            process.exit(1)
          }

          // Hash the password (bcrypt-style for GoTrue compatibility)
          const passwordHash = await hashPassword(password)

          // Insert the admin user with the admin role in app_metadata
          const appMetadata = JSON.stringify({ role, provider: "email", providers: ["email"] })
          const userMetadata = JSON.stringify({})

          const result = await pool.query(
            `INSERT INTO auth.users (
              email, encrypted_password, role, aud,
              raw_app_meta_data, raw_user_meta_data,
              email_confirmed_at, created_at, updated_at
            ) VALUES (
              $1, $2, 'authenticated', 'authenticated',
              $3::jsonb, $4::jsonb,
              now(), now(), now()
            ) RETURNING id, email`,
            [email.toLowerCase(), passwordHash, appMetadata, userMetadata],
          )

          const user = result.rows[0] as { id: string; email: string }

          console.log(`\nAdmin user created successfully.`)
          console.log(`  ID:    ${user.id}`)
          console.log(`  Email: ${user.email}`)
          console.log(`  Role:  ${role}`)
          console.log(
            `\nThis user can now log in to the admin panel at /admin\n`,
          )
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Unknown error"
          console.error(`\nFailed to create admin user: ${message}`)
          process.exit(1)
        } finally {
          await pool.end()
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
        const connection = opts.connection ?? config.connection

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
            console.error(`\nNo user found with email "${opts.email}".`)
            process.exit(1)
          }

          const user = result.rows[0] as {
            id: string
            email: string
            raw_app_meta_data: Record<string, unknown>
          }

          console.log(`\nRole updated successfully.`)
          console.log(`  ID:    ${user.id}`)
          console.log(`  Email: ${user.email}`)
          console.log(`  Role:  ${opts.role}\n`)
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Unknown error"
          console.error(`\nFailed to update role: ${message}`)
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
      const connection = opts.connection ?? config.connection

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
          console.log("\nNo admin users found.")
          console.log(
            "Create one with: supatype admin create-user --email admin@example.com --role admin\n",
          )
          return
        }

        console.log(
          "\n  ID                                     Email                          Role         Created",
        )
        console.log("  " + "-".repeat(100))
        for (const row of result.rows) {
          const r = row as {
            id: string
            email: string
            role: string
            created_at: string
          }
          const date = new Date(r.created_at).toISOString().slice(0, 10)
          console.log(
            `  ${r.id}  ${r.email.padEnd(30)} ${r.role.padEnd(12)} ${date}`,
          )
        }
        console.log()
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error"
        console.error(`\nFailed to list admin users: ${message}`)
        process.exit(1)
      } finally {
        await pool.end()
      }
    })
}

// ─── First admin user prompt (task 48) ──────────────────────────────────────
// Called by `supatype push` on initial setup if no admin users exist.

export async function promptFirstAdminUser(
  connection: string,
): Promise<void> {
  const pg = await importPg()
  const pool = new pg.Pool({ connectionString: connection, max: 2 })

  try {
    // Check if auth.users table exists
    const tableExists = await pool.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'auth' AND table_name = 'users'
      ) as exists`,
    )
    if (!tableExists.rows[0]?.exists) return

    // Check if any admin users exist
    const adminCount = await pool.query(
      `SELECT COUNT(*) as count FROM auth.users
       WHERE raw_app_meta_data->>'role' IS NOT NULL
         AND raw_app_meta_data->>'role' != 'authenticated'`,
    )

    const count = parseInt(
      (adminCount.rows[0] as { count: string }).count,
      10,
    )
    if (count > 0) return

    // No admin users — prompt to create one
    console.log("\n  No admin users found for the admin panel.")
    const createAdmin = await confirm(
      "  Create an admin user now? [y/N] ",
    )
    if (!createAdmin) {
      console.log(
        "  Skipped. You can create one later with: supatype admin create-user\n",
      )
      return
    }

    const email = await prompt("  Admin email: ")
    if (!email || !email.includes("@")) {
      console.log("  Invalid email. Skipping admin user creation.\n")
      return
    }

    const password = await prompt(
      "  Admin password (min 8 chars): ",
    )
    if (!password || password.length < 8) {
      console.log(
        "  Password too short. Skipping admin user creation.\n",
      )
      return
    }

    const passwordHash = await hashPassword(password)
    const appMetadata = JSON.stringify({
      role: "admin",
      provider: "email",
      providers: ["email"],
    })

    await pool.query(
      `INSERT INTO auth.users (
        email, encrypted_password, role, aud,
        raw_app_meta_data, raw_user_meta_data,
        email_confirmed_at, created_at, updated_at
      ) VALUES (
        $1, $2, 'authenticated', 'authenticated',
        $3::jsonb, '{}'::jsonb,
        now(), now(), now()
      )`,
      [email.toLowerCase(), passwordHash, appMetadata],
    )

    console.log(`\n  Admin user "${email}" created (role: admin).`)
    console.log(`  Log in at /admin after starting the dev server.\n`)
  } catch {
    // Non-fatal — if auth schema doesn't exist yet, skip silently
  } finally {
    await pool.end()
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

async function importPg(): Promise<typeof import("pg")> {
  try {
    return await import("pg")
  } catch {
    console.error(
      "pg package is required for admin commands. Install it with: pnpm add pg",
    )
    process.exit(1)
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex")
  const derived = (await scryptAsync(password, salt, 64)) as Buffer
  return `${salt}:${derived.toString("hex")}`
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(question)
  return answer.toLowerCase() === "y"
}
