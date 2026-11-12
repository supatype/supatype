/**
 * Two projects in one S3 bucket, as Supatype Cloud runs them: every project environment's service
 * has `S3_BUCKET` set to the platform's bucket and `S3_KEY_PREFIX` to `<project ref>/<environment>`.
 *
 * This service is project abc123's production. Another project's files, and abc123's own staging
 * files, are already in the bucket, put there by the admin login. Whatever this service is asked,
 * through its own HTTP routes, it must never read, list, overwrite or delete them.
 *
 * Needs Docker for Postgres and SeaweedFS. Without it the suite is skipped with a message.
 */
import { spawnSync } from "node:child_process"
import type { Server } from "node:http"
import { CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3"
import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { isShape, isString } from "../src/json.js"
import { APP, startSeaweed, type Seaweed } from "./support/seaweed.js"
import { connectWhenReady, dockerAvailable, provision, sign, startPostgres, startService } from "./support/stack.js"

const SECRET = "s3-key-prefix-test-secret-at-least-32-chars"
const SERVICE = sign(SECRET, { role: "service_role" })
const SHARED = "platform-files"
const OURS = "abc123/production"
/** What every file of someone else's holds. A refusal may quote the name it refused, never these bytes. */
const OTHERS_BYTES = "other-project-bytes-7f3a"

/** Files that belong to someone else: another project, abc123's staging, and a look-alike folder. */
const NOT_OURS = [
  "other/production/photos/secret.txt/v1",
  "abc123/staging/photos/secret.txt/v1",
  "abc123/production-copy/photos/secret.txt/v1",
] as const

if (!dockerAvailable) console.warn("[s3-key-prefix] Docker is not available: skipping the shared-bucket suite")

let seaweed: Seaweed | undefined
let pgContainer = ""
let admin: pg.Client | undefined
let server: Server | undefined
let base = ""

beforeAll(async () => {
  if (!dockerAvailable) return
  seaweed = await startSeaweed([`Read:${SHARED}`, `Write:${SHARED}`, `List:${SHARED}`])
  await seaweed.admin.send(new CreateBucketCommand({ Bucket: SHARED }))
  for (const Key of NOT_OURS) await seaweed.admin.send(new PutObjectCommand({ Bucket: SHARED, Key, Body: OTHERS_BYTES }))
  Object.assign(process.env, {
    S3_BUCKET: SHARED,
    S3_KEY_PREFIX: OURS,
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

const json = (value: unknown): string => JSON.stringify(value)

/** Every key in the shared bucket under `prefix`, as the admin login sees them. */
async function keysUnder(prefix: string): Promise<string[]> {
  const res = await seaweed!.admin.send(new ListObjectsV2Command({ Bucket: SHARED, Prefix: prefix }))
  return (res.Contents ?? []).map((o) => o.Key ?? "")
}

/** What the admin login reads at `key`: the other projects' files must still hold {@link OTHERS_BYTES}. */
async function bytesAt(key: string): Promise<string> {
  const res = await seaweed!.admin.send(new GetObjectCommand({ Bucket: SHARED, Key: key }))
  return (await res.Body?.transformToString()) ?? ""
}

async function expectOthersUntouched(): Promise<void> {
  for (const key of NOT_OURS) expect(await bytesAt(key), key).toBe(OTHERS_BYTES)
}

describe.skipIf(!dockerAvailable)("two projects in one S3 bucket", () => {
  it("stores this project's files under <project>/<environment>/<bucket>/ and nowhere else", async () => {
    expect((await call("POST", "/bucket", json({ name: "photos" }), "application/json")).status).toBe(200)
    expect((await call("POST", "/object/photos/cat.txt", "meow", "text/plain")).status).toBe(200)

    const ours = await keysUnder(`${OURS}/photos/cat.txt/`)
    expect(ours).toHaveLength(1)
    const everything = await keysUnder("")
    expect(everything.filter((key) => !NOT_OURS.some((other) => other === key))).toEqual(ours)
  })

  it("lists only this project's files, though the other projects use the same bucket name", async () => {
    const listed = await call("POST", "/object/list/photos", json({ prefix: "" }), "application/json")
    const names = json(await listed.json())
    expect(names).toContain("cat.txt")
    expect(names).not.toContain("secret.txt")
  })

  it.each([
    "/object/authenticated/photos/..%2F..%2F..%2Fother%2Fproduction%2Fphotos%2Fsecret.txt",
    "/object/authenticated/photos/../../../other/production/photos/secret.txt",
    "/object/authenticated/photos/..%2Fphotos%2F..%2F..%2Fstaging%2Fphotos%2Fsecret.txt",
    "/object/authenticated/..%2Fstaging%2Fphotos/secret.txt",
    "/object/authenticated/%2E%2E/staging/photos/secret.txt",
    "/object/public/..%2F..%2Fother%2Fproduction%2Fphotos/secret.txt",
  ])("never serves another project's file through %s", async (path) => {
    const res = await call("GET", path)
    expect(res.status).not.toBe(200)
    expect(await res.text()).not.toContain(OTHERS_BYTES)
  })

  it.each(["..", ".", "a/b", "..%2Fother"])("refuses a bucket named %j", async (name) => {
    const res = await call("POST", "/bucket", json({ name }), "application/json")
    expect(res.status).toBeGreaterThanOrEqual(400)
    await expectOthersUntouched()
  })

  it("never writes over another project's file by uploading to a climbing name", async () => {
    for (const name of ["..%2F..%2F..%2Fother%2Fproduction%2Fphotos%2Fsecret.txt", "a%2F..%2F..%2F..%2Fother"]) {
      const res = await call("POST", `/object/photos/${name}`, "overwritten", "text/plain")
      expect(res.status, name).toBeGreaterThanOrEqual(400)
    }
    await expectOthersUntouched()
  })

  it("signs a URL that reaches only this project's file", async () => {
    const signed = await call("POST", "/object/sign/photos/cat.txt", json({ expiresIn: 60 }), "application/json")
    const body: unknown = await signed.json()
    if (!isShape({ signedURL: isString })(body)) throw new Error(`no signed URL: ${json(body)}`)
    expect(await (await fetch(`${base}${body.signedURL}`)).text()).toBe("meow")
  })

  it("empties and deletes its bucket without touching the others' files of the same bucket name", async () => {
    expect((await call("POST", "/bucket/photos/empty")).status).toBe(200)
    expect((await call("DELETE", "/bucket/photos")).status).toBe(200)
    expect(await keysUnder(`${OURS}/`)).toEqual([])
    await expectOthersUntouched()
  })
})
