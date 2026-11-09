/**
 * The service with `S3_BUCKET` set, through its own HTTP routes, on a real Postgres and a real
 * SeaweedFS: every Supatype bucket is a key prefix inside that one S3 bucket, as Supabase Storage
 * keeps them under `GLOBAL_S3_BUCKET`.
 *
 * The service's login may only read, write and list the one bucket, which is all a bucket of your
 * own on AWS or R2 grants it. So a create that still made an S3 bucket per Supatype bucket, or put a
 * bucket policy, fails here as it would there. A second, admin login looks at what landed in S3.
 *
 * Needs Docker for Postgres and SeaweedFS. Without it the suite is skipped with a message.
 */
import { spawnSync } from "node:child_process"
import type { Server } from "node:http"
import { CreateBucketCommand, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3"
import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { isShape, isString } from "../src/json.js"
import { APP, startSeaweed, type Seaweed } from "./support/seaweed.js"
import { connectWhenReady, dockerAvailable, provision, sign, startPostgres, startService } from "./support/stack.js"

const SECRET = "s3-single-bucket-test-secret-at-least-32"
const SERVICE = sign(SECRET, { role: "service_role" })
const SHARED = "app-objects"
const SINGLE_BUCKET_POLICY_REFUSAL =
  "s3BucketPolicy needs one S3 bucket per Supatype bucket, which single-bucket mode (S3_BUCKET) does not give. " +
  "Remove S3_BUCKET to use one S3 bucket per Supatype bucket (set S3_BUCKET_PREFIX to keep names unique), or drop s3BucketPolicy."

if (!dockerAvailable) console.warn("[s3-single-bucket] Docker is not available: skipping the single-bucket suite")

let seaweed: Seaweed | undefined
let pgContainer = ""
let admin: pg.Client | undefined
let server: Server | undefined
let base = ""

beforeAll(async () => {
  if (!dockerAvailable) return
  seaweed = await startSeaweed([`Read:${SHARED}`, `Write:${SHARED}`, `List:${SHARED}`])
  await seaweed.admin.send(new CreateBucketCommand({ Bucket: SHARED }))
  Object.assign(process.env, { S3_BUCKET: SHARED, S3_ENDPOINT: seaweed.endpoint, S3_ACCESS_KEY: APP.accessKeyId, S3_SECRET_KEY: APP.secretAccessKey })
  const pgStack = startPostgres()
  pgContainer = pgStack.container
  admin = await connectWhenReady(pgStack.url)
  await provision(admin)
  const started = await startService(pgStack.url, SECRET)
  server = started.server
  base = started.base
}, 180_000)

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  if (server) await (await import("../src/db.js")).closePool()
  await admin?.end().catch(() => undefined)
  seaweed?.stop()
  if (pgContainer) spawnSync("docker", ["rm", "-f", pgContainer], { stdio: "ignore" })
})

function call(method: string, path: string, body?: string | Buffer, contentType?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${SERVICE}`, ...(contentType !== undefined && { "content-type": contentType }) },
    ...(body !== undefined && { body }),
  })
}

async function createBucket(bucket: Record<string, unknown>): Promise<Response> {
  return call("POST", "/bucket", JSON.stringify(bucket), "application/json")
}

/** Every key in the shared bucket under `prefix`, as the admin login sees them. */
async function keysUnder(prefix: string): Promise<string[]> {
  const res = await seaweed!.admin.send(new ListObjectsV2Command({ Bucket: SHARED, Prefix: prefix }))
  return (res.Contents ?? []).map((o) => o.Key ?? "")
}

describe.skipIf(!dockerAvailable)("the service on one S3 bucket", () => {
  it("creates a public bucket without an S3 bucket of its own and serves its files itself", async () => {
    const created = await createBucket({ name: "photos", public: true })
    expect(created.status, await created.clone().text()).toBe(200)
    expect((await call("POST", "/object/photos/cats/one.txt", "meow", "text/plain")).status).toBe(200)

    expect(await keysUnder("photos/cats/one.txt/")).toHaveLength(1)
    const buckets = await seaweed!.admin.send(new ListBucketsCommand({}))
    expect((buckets.Buckets ?? []).map((b) => b.Name)).not.toContain("photos")

    const res = await fetch(`${base}/object/public/photos/cats/one.txt`, { redirect: "manual" })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("meow")
  })

  it("reads, lists and signs a private bucket's files through the service", async () => {
    expect((await createBucket({ name: "private-docs" })).status).toBe(200)
    expect((await call("POST", "/object/private-docs/a.txt", "secret", "text/plain")).status).toBe(200)

    expect((await fetch(`${base}/object/public/private-docs/a.txt`)).status).not.toBe(200)
    expect(await (await call("GET", "/object/authenticated/private-docs/a.txt")).text()).toBe("secret")

    const listed = await call("POST", "/object/list/private-docs", JSON.stringify({ prefix: "" }), "application/json")
    expect(JSON.stringify(await listed.json())).toContain("a.txt")

    const signed = await call("POST", "/object/sign/private-docs/a.txt", JSON.stringify({ expiresIn: 60 }), "application/json")
    const body: unknown = await signed.json()
    if (!isShape({ signedURL: isString })(body)) throw new Error(`no signed URL: ${JSON.stringify(body)}`)
    expect(await (await fetch(`${base}${body.signedURL}`)).text()).toBe("secret")
  })

  it("replaces an overwritten file's bytes under the same prefix", async () => {
    expect((await createBucket({ name: "overwrite" })).status).toBe(200)
    await call("POST", "/object/overwrite/f.txt", "one", "text/plain")
    const again = await fetch(`${base}/object/overwrite/f.txt`, {
      method: "POST",
      headers: { authorization: `Bearer ${SERVICE}`, "content-type": "text/plain", "x-upsert": "true" },
      body: "two",
    })
    expect(again.status, await again.clone().text()).toBe(200)
    expect(await (await call("GET", "/object/overwrite/f.txt")).text()).toBe("two")
    expect(await keysUnder("overwrite/")).toHaveLength(1)
  })

  it("enforces the bucket's size limit and accepted types", async () => {
    expect((await createBucket({ name: "limited", file_size_limit: 4, allowed_mime_types: ["text/plain"] })).status).toBe(200)
    expect((await call("POST", "/object/limited/big.txt", "too long", "text/plain")).status).toBe(413)
    expect((await call("POST", "/object/limited/a.bin", "ab", "application/octet-stream")).status).toBe(415)
  })

  it("deletes a file's bytes, empties a bucket's prefix and deletes the bucket", async () => {
    expect((await createBucket({ name: "scratch" })).status).toBe(200)
    await call("POST", "/object/scratch/gone.txt", "x", "text/plain")
    await call("POST", "/object/scratch/kept/one.txt", "y", "text/plain")
    await call("POST", "/object/scratch/kept/two.txt", "z", "text/plain")

    const removed = await call("DELETE", "/object/scratch", JSON.stringify({ prefixes: ["gone.txt"] }), "application/json")
    expect(removed.status).toBe(200)
    expect(await keysUnder("scratch/gone.txt")).toEqual([])

    expect((await call("POST", "/bucket/scratch/empty")).status).toBe(200)
    expect(await keysUnder("scratch/")).toEqual([])
    // Bytes no row points at, as an upload whose row never committed leaves: the bucket takes them.
    await seaweed!.admin.send(new PutObjectCommand({ Bucket: SHARED, Key: "scratch/orphan.txt/v1", Body: "o" }))
    expect((await call("DELETE", "/bucket/scratch")).status).toBe(200)
    expect(await keysUnder("scratch/")).toEqual([])
    expect((await call("GET", "/bucket/scratch")).status).toBe(404)
    expect(await keysUnder("photos/")).not.toEqual([])
  })

  // Nic's decision for 0.9.2: the refusal names the way out, per-bucket mode, rather than only the problem.
  it("refuses an S3 bucket policy with 400, saying to use one S3 bucket per Supatype bucket for it", async () => {
    const policy = JSON.stringify({ Version: "2012-10-17", Statement: [] })
    const created = await createBucket({ name: "with-policy", s3_bucket_policy: policy })
    expect(created.status).toBe(400)
    expect(await created.json()).toEqual({ error: SINGLE_BUCKET_POLICY_REFUSAL })
    const updated = await call("PUT", "/bucket/photos", JSON.stringify({ s3_bucket_policy: policy }), "application/json")
    expect(updated.status).toBe(400)
    expect(await updated.json()).toEqual({ error: SINGLE_BUCKET_POLICY_REFUSAL })
  })
})
