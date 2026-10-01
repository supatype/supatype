/**
 * A bucket's declared rules, enforced by Postgres, through the service's own routes.
 *
 * The service used to write and delete on a connection that bypasses row level security, and to
 * decide access itself from `access_mode`. So the anon key could upload to a bucket declaring
 * `create: BucketLoggedIn` (supatype#81), any signed-in user could delete anyone's objects
 * (supatype#82), a `custom` bucket let every signed-in user read everything, and a list returned
 * every name in a private bucket. The policies were correct throughout; nothing asked them.
 *
 * This runs the real HTTP handlers against a real Postgres carrying the policies the engine
 * generates for `fixtures/rules.ast.json`, with S3 replaced by a map. The SQL in `fixtures/` is
 * engine output, regenerated with:
 *
 *   supatype-engine auth-functions -i fixtures/rules.ast.json > fixtures/auth.gen.sql
 *   supatype-engine storage -i fixtures/rules.ast.json > fixtures/storage.gen.sql
 *
 * Needs Docker. Without it the suite is skipped with a message rather than silently passing.
 */
import { spawnSync } from "node:child_process"
import { createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import { join } from "node:path"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const SECRET = "caller-rules-test-secret-at-least-32-chars"
const FIXTURES = join(import.meta.dirname, "fixtures")

/** Objects the mocked S3 holds, keyed `bucket/key`. */
const stored = new Map<string, Buffer>()
let failPutFor: string | null = null
/** Runs after a put has stored its bytes, so a test can act mid-upload or fail it then. */
let afterPut: ((bucket: string, key: string) => Promise<void>) | null = null

/** An object's S3 keys: `name` itself, and any `name/<version>`. */
function keyIsFor(key: string, name: string): boolean {
  return key === name || key.startsWith(`${name}/`)
}

vi.mock("../src/s3.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/s3.js")>()
  return {
    ...real,
    putObject: async (bucket: string, key: string, body: Buffer) => {
      if (failPutFor !== null && keyIsFor(key, failPutFor)) throw new Error("S3 is down")
      stored.set(`${bucket}/${key}`, body)
      await afterPut?.(bucket, key)
    },
    getObject: async (bucket: string, key: string) => {
      const body = stored.get(`${bucket}/${key}`)
      if (!body) throw Object.assign(new Error("missing"), { name: "NoSuchKey" })
      return { body, contentType: "text/plain", contentLength: body.length }
    },
    deleteObjects: async (bucket: string, keys: string[]) => {
      for (const key of keys) stored.delete(`${bucket}/${key}`)
    },
    deleteObject: async (bucket: string, key: string) => {
      stored.delete(`${bucket}/${key}`)
    },
  }
})

// ─── Postgres ─────────────────────────────────────────────────────────────────

const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0
if (!dockerAvailable) console.warn("[caller-rules] Docker is not available: skipping the storage rules suite")

let container = ""
let admin: pg.Client
let server: Server
let base = ""

function docker(args: string[]): string {
  const res = spawnSync("docker", args, { encoding: "utf8" })
  if (res.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${res.stderr}`)
  return res.stdout.trim()
}

async function connectWhenReady(url: string): Promise<pg.Client> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const client = new pg.Client({ connectionString: url })
    try {
      await client.connect()
      return client
    } catch {
      await client.end().catch(() => undefined)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error("Postgres did not accept connections")
}

/** The roles the gateway issues, then the engine's SQL, in the order a push applies it. */
async function provision(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  `)
  await client.query(readFileSync(join(FIXTURES, "auth.gen.sql"), "utf8"))
  await client.query(readFileSync(join(FIXTURES, "storage.gen.sql"), "utf8"))
}

async function startService(databaseUrl: string): Promise<void> {
  process.env["DATABASE_URL"] = databaseUrl
  process.env["JWT_SECRET"] = SECRET
  const { createServer } = await import("../src/server.js")
  server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (let attempt = 0; attempt < 60; attempt++) {
    const health = (await (await fetch(`${base}/health`)).json()) as { status: string }
    if (health.status === "ok") return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error("storage service never became ready")
}

beforeAll(async () => {
  if (!dockerAvailable) return
  container = docker(["run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:17-alpine"])
  const port = docker(["port", container, "5432"]).split(":").pop()
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`
  admin = await connectWhenReady(url)
  await provision(admin)
  await startService(url)
}, 120_000)

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  if (server) await (await import("../src/db.js")).closePool()
  await admin?.end().catch(() => undefined)
  if (container) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" })
})

// ─── Callers ──────────────────────────────────────────────────────────────────

function sign(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")
  const head = `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}`
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`
}

const ANON = sign({ role: "anon" })
const SERVICE = sign({ role: "service_role" })

interface User {
  id: string
  token: string
}

function user(): User {
  const id = randomUUID()
  return { id, token: sign({ sub: id, role: "authenticated" }) }
}

async function upload(token: string, bucket: string, name: string, body: string, upsert = false): Promise<Response> {
  return fetch(`${base}/object/${bucket}/${name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "text/plain",
      ...(upsert && { "x-upsert": "true" }),
    },
    body,
  })
}

async function remove(token: string, bucket: string, names: string[]): Promise<Response> {
  return fetch(`${base}/object/${bucket}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ prefixes: names }),
  })
}

async function list(token: string, bucket: string, prefix = ""): Promise<string[]> {
  const res = await fetch(`${base}/object/list/${bucket}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ prefix }),
  })
  return ((await res.json()) as { name: string }[]).map((o) => o.name)
}

async function row(bucket: string, name: string): Promise<{ owner: string | null; version: string | null } | undefined> {
  const res = await admin.query<{ owner: string | null; version: string | null }>(
    "SELECT owner, version FROM storage.objects WHERE bucket_id = $1 AND name = $2",
    [bucket, name],
  )
  return res.rows[0]
}

/** The bytes the object's row points at: `name/<version>`, or `name` for a row with no version. */
async function bytesOf(bucket: string, name: string): Promise<string | undefined> {
  const version = (await row(bucket, name))?.version
  return stored.get(`${bucket}/${version ? `${name}/${version}` : name}`)?.toString()
}

/** Every S3 key held for the object, live or not. */
function keysOf(bucket: string, name: string): string[] {
  return [...stored.keys()].filter((k) => k.startsWith(`${bucket}/`) && keyIsFor(k.slice(bucket.length + 1), name))
}

function unique(prefix: string): string {
  return `${prefix}-${randomUUID()}.txt`
}

// ─── Rules ────────────────────────────────────────────────────────────────────

describe.skipIf(!dockerAvailable)("bucket rules, enforced by Postgres", () => {
  it("refuses the anon key where create is BucketLoggedIn, and stores nothing (#81)", async () => {
    const name = unique("anon")
    const res = await upload(ANON, "avatars", name, "x")
    expect(res.status).toBe(401)
    expect(await row("avatars", name)).toBeUndefined()
    expect(keysOf("avatars", name)).toEqual([])
  })

  it("lets a signed-in user upload, owned by them", async () => {
    const x = user()
    const name = unique("own")
    expect((await upload(x.token, "avatars", name, "x")).status).toBe(200)
    expect((await row("avatars", name))?.owner).toBe(x.id)
  })

  it("leaves another user's object where delete is BucketOwner (#82)", async () => {
    const x = user()
    const y = user()
    const name = unique("theirs")
    await upload(x.token, "avatars", name, "x's bytes")

    const res = await remove(y.token, "avatars", [name])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(await row("avatars", name)).toBeDefined()
    expect(await bytesOf("avatars", name)).toBe("x's bytes")
  })

  it("lets the owner delete their own object, row and bytes", async () => {
    const x = user()
    const name = unique("mine")
    await upload(x.token, "avatars", name, "x")

    const res = await remove(x.token, "avatars", [name])
    expect(await res.json()).toEqual([{ name, bucket_id: "avatars" }])
    expect(await row("avatars", name)).toBeUndefined()
    expect(keysOf("avatars", name)).toEqual([])
  })

  it("refuses an overwrite of another user's object where update is BucketOwner", async () => {
    const x = user()
    const y = user()
    const name = unique("overwrite")
    await upload(x.token, "avatars", name, "original")

    expect((await upload(y.token, "avatars", name, "replaced", true)).status).toBe(403)
    expect(await bytesOf("avatars", name)).toBe("original")
    expect((await row("avatars", name))?.owner).toBe(x.id)
  })

  it("lets the owner overwrite their own object, which stays theirs", async () => {
    const x = user()
    const name = unique("again")
    await upload(x.token, "avatars", name, "first")

    expect((await upload(x.token, "avatars", name, "second", true)).status).toBe(200)
    expect(await bytesOf("avatars", name)).toBe("second")
    expect((await row("avatars", name))?.owner).toBe(x.id)
  })

  it("answers 409 for an existing object without x-upsert", async () => {
    const x = user()
    const name = unique("dup")
    await upload(x.token, "avatars", name, "first")
    expect((await upload(x.token, "avatars", name, "second")).status).toBe(409)
  })

  it("refuses an update and a delete the bucket declares no rule for", async () => {
    const x = user()
    const name = unique("dropbox")
    expect((await upload(x.token, "dropbox", name, "kept")).status).toBe(200)

    expect((await upload(x.token, "dropbox", name, "changed", true)).status).toBe(403)
    expect(await (await remove(x.token, "dropbox", [name])).json()).toEqual([])
    expect(await bytesOf("dropbox", name)).toBe("kept")
  })

  it("refuses every write to a bucket that declares no rules", async () => {
    const x = user()
    const name = unique("loose")
    expect((await upload(x.token, "loose", name, "x")).status).toBe(403)
    expect(await row("loose", name)).toBeUndefined()
  })

  it("still lets the service role write where no rule allows it", async () => {
    const name = unique("service")
    expect((await upload(SERVICE, "loose", name, "x")).status).toBe(200)
  })

  it("asks the read rule for a custom bucket instead of letting every signed-in user in", async () => {
    const x = user()
    const y = user()
    const name = unique("vault")
    await upload(x.token, "vault", name, "secret")

    const asY = await fetch(`${base}/object/authenticated/vault/${name}`, {
      headers: { authorization: `Bearer ${y.token}` },
    })
    expect(asY.status).toBe(403)
    const asX = await fetch(`${base}/object/authenticated/vault/${name}`, {
      headers: { authorization: `Bearer ${x.token}` },
    })
    expect(asX.status).toBe(200)
  })

  it("lists only what the caller's read rule allows", async () => {
    const x = user()
    const y = user()
    const name = unique("listed")
    await upload(x.token, "vault", name, "secret")

    expect(await list(y.token, "vault")).not.toContain(name)
    expect(await list(x.token, "vault")).toContain(name)
  })

  it("treats a prefix as text, not a LIKE pattern", async () => {
    const x = user()
    const name = unique("pct")
    await upload(x.token, "avatars", name, "x")
    expect(await list(x.token, "avatars", "%")).toEqual([])
  })

  it("leaves no row behind when storing the bytes fails", async () => {
    const x = user()
    const name = unique("s3-down")
    failPutFor = name
    try {
      expect((await upload(x.token, "avatars", name, "x")).status).toBe(500)
    } finally {
      failPutFor = null
    }
    expect(await row("avatars", name)).toBeUndefined()
  })

  // ─── Versioned uploads ──────────────────────────────────────────────────────

  it("holds no database transaction open while the bytes are uploading", async () => {
    const x = user()
    const name = unique("held")
    let openDuringPut = -1
    afterPut = async () => {
      const res = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND state LIKE 'idle in transaction%'`,
      )
      openDuringPut = res.rows[0]?.n ?? -1
    }
    try {
      expect((await upload(x.token, "avatars", name, "x")).status).toBe(200)
    } finally {
      afterPut = null
    }
    expect(openDuringPut).toBe(0)
  })

  it("keeps serving the old bytes when an overwrite fails after its bytes were stored", async () => {
    const x = user()
    const name = unique("keep-old")
    await upload(x.token, "avatars", name, "old")
    afterPut = async () => {
      throw new Error("S3 timed out after storing")
    }
    try {
      expect((await upload(x.token, "avatars", name, "new", true)).status).toBe(500)
    } finally {
      afterPut = null
    }
    expect(await bytesOf("avatars", name)).toBe("old")
    expect(keysOf("avatars", name)).toHaveLength(1)
  })

  it("leaves nothing behind when a new object's upload fails after its bytes were stored", async () => {
    const x = user()
    const name = unique("leftover")
    afterPut = async () => {
      throw new Error("S3 timed out after storing")
    }
    try {
      expect((await upload(x.token, "avatars", name, "x")).status).toBe(500)
    } finally {
      afterPut = null
    }
    expect(await row("avatars", name)).toBeUndefined()
    expect(keysOf("avatars", name)).toEqual([])
  })

  it("removes the uploaded bytes when the rules refuse the write at commit", async () => {
    // Allowed when checked, refused by the time the row is written: the grant goes away mid-upload.
    const x = user()
    const name = unique("refused-late")
    afterPut = async () => {
      await admin.query("REVOKE INSERT ON storage.objects FROM authenticated")
    }
    try {
      expect((await upload(x.token, "avatars", name, "x")).status).toBe(403)
    } finally {
      afterPut = null
      await admin.query("GRANT INSERT ON storage.objects TO authenticated")
    }
    expect(await row("avatars", name)).toBeUndefined()
    expect(keysOf("avatars", name)).toEqual([])
  })

  it("lets one of two concurrent creates of a path win, and answers 409 to the other", async () => {
    const x = user()
    const name = unique("race")
    const results = await Promise.all([
      upload(x.token, "avatars", name, "first"),
      upload(x.token, "avatars", name, "second"),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(keysOf("avatars", name)).toHaveLength(1)
  })

  it("deletes the previous version's bytes once an overwrite has committed", async () => {
    const x = user()
    const name = unique("superseded")
    await upload(x.token, "avatars", name, "first")
    const first = (await row("avatars", name))?.version
    await upload(x.token, "avatars", name, "second", true)
    const second = (await row("avatars", name))?.version

    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
    expect(keysOf("avatars", name)).toEqual([`avatars/${name}/${second}`])
  })

  it("serves an object written before versions from its unversioned key", async () => {
    const x = user()
    const name = unique("legacy")
    await admin.query(
      "INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('vault', $1, $2, '{}')",
      [name, x.id],
    )
    stored.set(`vault/${name}`, Buffer.from("legacy bytes"))
    const res = await fetch(`${base}/object/authenticated/vault/${name}`, {
      headers: { authorization: `Bearer ${x.token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("legacy bytes")
  })

  it("removes a bucket's bytes when it is emptied, not only its rows", async () => {
    const name = unique("emptied")
    await upload(SERVICE, "loose", name, "x")
    const res = await fetch(`${base}/bucket/loose/empty`, {
      method: "POST",
      headers: { authorization: `Bearer ${SERVICE}` },
    })
    expect(res.status).toBe(200)
    expect(keysOf("loose", name)).toEqual([])
  })

  it("drops a policy an earlier push created that the schema no longer names, and only that", async () => {
    // A bucket removed from the schema leaves its policies behind, and a permissive one left there
    // is ORed with every other rule. The marker is what makes it ours to remove.
    await admin.query(`
      CREATE POLICY "storage_gone_ins" ON storage.objects FOR INSERT WITH CHECK (TRUE);
      COMMENT ON POLICY "storage_gone_ins" ON storage.objects
        IS 'supatype:managed;kind=storage_policy;table=objects;fields=storage_gone_ins;v=1';
      CREATE POLICY "hand_written" ON storage.objects FOR SELECT USING (FALSE);
    `)
    await admin.query(readFileSync(join(FIXTURES, "storage.gen.sql"), "utf8"))

    const left = await admin.query<{ polname: string }>(
      "SELECT polname FROM pg_policy WHERE polrelid = 'storage.objects'::regclass AND polname IN ('storage_gone_ins', 'hand_written')",
    )
    expect(left.rows.map((r) => r.polname)).toEqual(["hand_written"])
    await admin.query('DROP POLICY "hand_written" ON storage.objects')
  })

  it("refuses with an explanation, not a 500, on a database missing the grants", async () => {
    const x = user()
    const name = unique("ungranted")
    await admin.query("REVOKE INSERT ON storage.objects FROM authenticated")
    try {
      const res = await upload(x.token, "avatars", name, "x")
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: "Storage is not configured for this request yet" })
    } finally {
      await admin.query("GRANT INSERT ON storage.objects TO authenticated")
    }
    expect(await row("avatars", name)).toBeUndefined()
  })
})
