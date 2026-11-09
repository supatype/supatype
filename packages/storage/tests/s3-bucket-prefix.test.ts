/**
 * The service with an S3 bucket per Supatype bucket and `S3_BUCKET_PREFIX` set, through its own HTTP
 * routes, on a real Postgres and a real SeaweedFS (0.9.2, Nic's decision). This is the mode for a
 * project that needs a bucket policy of its own per bucket; the prefix keeps its S3 bucket names
 * apart from every other account's, which AWS requires of every bucket name in a partition.
 *
 * Needs Docker for Postgres and SeaweedFS. Without it the suite is skipped with a message.
 */
import { spawnSync } from "node:child_process"
import type { Server } from "node:http"
import { HeadBucketCommand, ListBucketsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3"
import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { APP, startSeaweed, type Seaweed } from "./support/seaweed.js"
import { connectWhenReady, dockerAvailable, provision, sign, startPostgres, startService } from "./support/stack.js"

const SECRET = "s3-bucket-prefix-test-secret-at-least-32"
const SERVICE = sign(SECRET, { role: "service_role" })
const PREFIX = "acme-"

if (!dockerAvailable) console.warn("[s3-bucket-prefix] Docker is not available: skipping the bucket prefix suite")

let seaweed: Seaweed | undefined
let pgContainer = ""
let admin: pg.Client | undefined
let server: Server | undefined
let base = ""

beforeAll(async () => {
  if (!dockerAvailable) return
  seaweed = await startSeaweed(["Admin", "Read", "List", "Tagging", "Write"])
  Object.assign(process.env, {
    S3_BUCKET_PREFIX: PREFIX,
    S3_ENDPOINT: seaweed.endpoint,
    S3_ACCESS_KEY: APP.accessKeyId,
    S3_SECRET_KEY: APP.secretAccessKey,
  })
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

function call(method: string, path: string, body?: string, contentType?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${SERVICE}`, ...(contentType !== undefined && { "content-type": contentType }) },
    ...(body !== undefined && { body }),
  })
}

async function s3BucketNames(): Promise<string[]> {
  const res = await seaweed!.admin.send(new ListBucketsCommand({}))
  return (res.Buckets ?? []).flatMap((b) => (b.Name === undefined ? [] : [b.Name]))
}

describe.skipIf(!dockerAvailable)("the service with S3_BUCKET_PREFIX", () => {
  it("makes the S3 bucket under the prefixed name, with the public policy on it", async () => {
    const created = await call("POST", "/bucket", JSON.stringify({ name: "photos", public: true }), "application/json")
    expect(created.status, await created.clone().text()).toBe(200)
    expect(await s3BucketNames()).toContain("acme-photos")
    expect(await s3BucketNames()).not.toContain("photos")

    expect((await call("POST", "/object/photos/cat.txt", "meow", "text/plain")).status).toBe(200)
    expect(await (await fetch(`${base}/object/public/photos/cat.txt`)).text()).toBe("meow")
    // Straight from S3 with no credentials: the policy went on the prefixed bucket.
    const listed = await seaweed!.admin.send(new ListObjectsV2Command({ Bucket: "acme-photos" }))
    const key = listed.Contents?.[0]?.Key ?? ""
    expect(key).toMatch(/^cat\.txt\//)
    expect((await fetch(`${seaweed!.endpoint}/acme-photos/${key}`)).status).toBe(200)
  })

  it("refuses with 400 a bucket id that makes no S3 bucket name once prefixed", async () => {
    const res = await call("POST", "/bucket", JSON.stringify({ name: "Team_Photos" }), "application/json")
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("acme-Team_Photos")
  })

  it("deletes the prefixed S3 bucket with the bucket", async () => {
    expect((await call("POST", "/bucket", JSON.stringify({ name: "scratch" }), "application/json")).status).toBe(200)
    await seaweed!.admin.send(new HeadBucketCommand({ Bucket: "acme-scratch" }))
    expect((await call("DELETE", "/bucket/scratch")).status).toBe(200)
    expect(await s3BucketNames()).not.toContain("acme-scratch")
  })
})
