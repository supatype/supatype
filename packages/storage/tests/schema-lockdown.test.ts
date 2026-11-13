/**
 * The storage tables are locked from the moment the service creates them.
 *
 * `ensureSchema()` used to create `storage.buckets` and `storage.objects` with row level security
 * off, and only a later `supatype push` turned it on. Until then any signed-in user could read any
 * object in a private bucket. These run `ensureSchema()` as the service does, as a plain login that
 * owns what it creates (a superuser would bypass row level security and prove nothing), against a
 * real Postgres. Needs Docker; without it the suite is skipped with a message.
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { connectWhenReady, dockerAvailable, FIXTURES, startPostgres } from "./support/stack.js"

if (!dockerAvailable) console.warn("[schema-lockdown] Docker is not available: skipping the storage lockdown suite")

const OWNER = "storage_owner"
const OWNER_PASSWORD = "owner-pw"
const USER_ID = "11111111-1111-1111-1111-111111111111"

let container: string | undefined
let admin: pg.Client | undefined
let baseUrl = ""

/** A URL for `database` as `user`, from the container's superuser URL. */
function urlFor(database: string, user: string, password: string): string {
  const url = new URL(baseUrl)
  url.username = user
  url.password = password
  url.pathname = `/${database}`
  return url.toString()
}

/** Runs the service's own `ensureSchema()` against `database` as the storage login. */
async function runEnsureSchema(database: string): Promise<void> {
  process.env["DATABASE_URL"] = urlFor(database, OWNER, OWNER_PASSWORD)
  process.env["JWT_SECRET"] = "schema-lockdown-test-secret-at-least-32-chars"
  vi.resetModules()
  const db = await import("../src/db.js")
  try {
    await db.ensureSchema()
  } finally {
    await db.closePool()
  }
}

async function connectAs(database: string, user: string, password: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: urlFor(database, user, password) })
  await client.connect()
  return client
}

/** A client logged in as the storage login on `database`. */
function ownerClient(database: string): Promise<pg.Client> {
  return connectAs(database, OWNER, OWNER_PASSWORD)
}

/** Runs `fn` with a client that is logged in as the storage login, and closes it after. */
async function asOwner<T>(database: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await ownerClient(database)
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function rowSecurityOf(client: pg.Client): Promise<boolean[]> {
  const res = await client.query<{ relrowsecurity: boolean }>(
    `SELECT relrowsecurity FROM pg_class
      WHERE relnamespace = 'storage'::regnamespace AND relname IN ('buckets', 'objects') ORDER BY relname`,
  )
  return res.rows.map((r) => r.relrowsecurity)
}

/** The SQLSTATE of the error `run` throws, or "none" when it does not. */
async function sqlState(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return "none"
  } catch (err) {
    return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : "unknown"
  }
}

/** Runs `fn` inside a transaction acting as `authenticated` with `USER_ID` as the caller, then rolls it back. */
async function asAuthenticated<T>(database: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await connectAs(database, "postgres", "postgres")
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('role', 'authenticated', true), set_config('request.jwt.claim.sub', $1, true)", [USER_ID])
    return await fn(client)
  } finally {
    await client.query("ROLLBACK").catch(() => undefined)
    await client.end()
  }
}

/** A private bucket with one object in it, written by the storage login. */
async function seedPrivateObject(database: string): Promise<void> {
  await asOwner(database, async (owner) => {
    await owner.query(`INSERT INTO storage.buckets (id, name) VALUES ('dropbox', 'dropbox') ON CONFLICT DO NOTHING`)
    await owner.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('dropbox', 'secret.txt') ON CONFLICT DO NOTHING`)
  })
}

/**
 * What the project database carries before storage starts: the schema the image creates, and the
 * default privileges it sets there, which hand every table the service creates to the API roles
 * (supatype-postgres, init-scripts/00000000000002-storage-schema.sql). Without row level security
 * those grants are the exposure. The owner may also name `auth.uid()` in the policies a push creates.
 */
const PROJECT_GRANTS = `
  CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION ${OWNER};
  GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA storage GRANT ALL ON TABLES TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA auth TO ${OWNER};
`

beforeAll(async () => {
  if (!dockerAvailable) return
  const started = startPostgres()
  container = started.container
  baseUrl = started.url
  const superuser = await connectWhenReady(started.url)
  admin = superuser
  await superuser.query(`CREATE ROLE ${OWNER} LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS`)
  for (const db of ["bare", "gateway", "existing"]) {
    await superuser.query(`CREATE DATABASE ${db}`)
    await superuser.query(`GRANT ALL ON DATABASE ${db} TO ${OWNER}`)
  }
  // `bare` is bootstrapped before the gateway roles exist, so those roles are made after it.
  await runEnsureSchema("bare")
  await superuser.query(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  `)
  const auth = readFileSync(join(FIXTURES, "auth.gen.sql"), "utf8")
  for (const db of ["gateway", "existing"]) {
    const c = await connectAs(db, "postgres", "postgres")
    try {
      await c.query(auth)
      await c.query(PROJECT_GRANTS)
    } finally {
      await c.end()
    }
  }
  await runEnsureSchema("gateway")
  await seedPrivateObject("gateway")
}, 120_000)

afterAll(async () => {
  await admin?.end().catch(() => undefined)
  if (container) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" })
})

describe.skipIf(!dockerAvailable)("storage tables locked by ensureSchema", () => {
  it("turns row level security on for both tables, without forcing it", async () => {
    await asOwner("gateway", async (c) => {
      const res = await c.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relnamespace = 'storage'::regnamespace AND relname IN ('buckets', 'objects') ORDER BY relname`,
      )
      expect(res.rows).toEqual([
        { relname: "buckets", relrowsecurity: true, relforcerowsecurity: false },
        { relname: "objects", relrowsecurity: true, relforcerowsecurity: false },
      ])
    })
  })

  it("starts on a database that has no gateway roles yet, and still locks the tables", async () => {
    expect(await asOwner("bare", rowSecurityOf)).toEqual([true, true])
  })

  it("lets a signed-in user with no policy read nothing and write nothing", async () => {
    await asAuthenticated("gateway", async (c) => {
      expect((await c.query("SELECT 1 FROM storage.objects")).rowCount).toBe(0)
      expect(await sqlState(() => c.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('dropbox', 'mine.txt')`))).toBe("42501")
    })
    await asAuthenticated("gateway", async (c) => {
      expect((await c.query(`UPDATE storage.objects SET name = 'taken.txt'`)).rowCount).toBe(0)
      expect((await c.query(`DELETE FROM storage.objects`)).rowCount).toBe(0)
    })
    const names = await asOwner("gateway", (c) => c.query<{ name: string }>("SELECT name FROM storage.objects"))
    expect(names.rows.map((r) => r.name)).toEqual(["secret.txt"])
  })

  it("shows a signed-in user no bucket", async () => {
    await asAuthenticated("gateway", async (c) => {
      expect((await c.query("SELECT 1 FROM storage.buckets")).rowCount).toBe(0)
    })
  })

  it("is safe to run twice, and the tables stay locked", async () => {
    await runEnsureSchema("gateway")
    await runEnsureSchema("gateway")
    expect(await asOwner("gateway", rowSecurityOf)).toEqual([true, true])
  })

  it("closes a database created before the fix, on its next start", async () => {
    await runEnsureSchema("existing")
    await asOwner("existing", async (c) => {
      await c.query("ALTER TABLE storage.buckets DISABLE ROW LEVEL SECURITY")
      await c.query("ALTER TABLE storage.objects DISABLE ROW LEVEL SECURITY")
      expect(await rowSecurityOf(c)).toEqual([false, false])
    })
    await seedPrivateObject("existing")
    await asAuthenticated("existing", async (c) => {
      expect((await c.query("SELECT 1 FROM storage.objects")).rowCount).toBe(1)
    })

    await runEnsureSchema("existing")

    await asAuthenticated("existing", async (c) => {
      expect((await c.query("SELECT 1 FROM storage.objects")).rowCount).toBe(0)
    })
  })

  it("leaves the storage login able to read and write both tables", async () => {
    await asOwner("gateway", async (c) => {
      await c.query(`INSERT INTO storage.buckets (id, name) VALUES ('docs', 'docs')`)
      await c.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('docs', 'a.txt')`)
      expect((await c.query(`SELECT 1 FROM storage.objects WHERE bucket_id = 'docs'`)).rowCount).toBe(1)
      expect((await c.query(`UPDATE storage.objects SET name = 'b.txt' WHERE bucket_id = 'docs'`)).rowCount).toBe(1)
      expect((await c.query(`SELECT 1 FROM storage.buckets WHERE id = 'docs'`)).rowCount).toBe(1)
      expect((await c.query(`DELETE FROM storage.objects WHERE bucket_id = 'docs'`)).rowCount).toBe(1)
      expect((await c.query(`DELETE FROM storage.buckets WHERE id = 'docs'`)).rowCount).toBe(1)
    })
  })

  it("takes a later push on top without conflict, and the policies it creates then apply", async () => {
    const push = readFileSync(join(FIXTURES, "storage.gen.sql"), "utf8")
    await asOwner("gateway", async (c) => {
      await c.query(push)
      await c.query(push)
      expect(await rowSecurityOf(c)).toEqual([true, true])
      await c.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('avatars', 'me.png')`)
    })
    await asAuthenticated("gateway", async (c) => {
      const rows = await c.query<{ name: string }>("SELECT name FROM storage.objects ORDER BY name")
      expect(rows.rows.map((r) => r.name)).toEqual(["me.png"])
    })
  })
})
