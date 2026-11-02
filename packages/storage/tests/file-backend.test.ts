/**
 * The service with `STORAGE_BACKEND=file`, through its own HTTP routes on a real Postgres: what
 * native `supatype dev` runs. The bytes go to disk, and everything else (the bucket's accepted types
 * and size limit, its access mode, image transforms) is the same code a deployment on S3 runs.
 *
 * Needs Docker for Postgres. Without it the suite is skipped with a message.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { request, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type pg from "pg"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { connectWhenReady, dockerAvailable, provision, sign, startPostgres, startService } from "./support/stack.js"

const SECRET = "file-backend-test-secret-at-least-32-chars"
const SERVICE = sign(SECRET, { role: "service_role" })
const BUCKET = "photos"

if (!dockerAvailable) console.warn("[file-backend] Docker is not available: skipping the file backend suite")

const root = mkdtempSync(join(tmpdir(), "storage-file-backend-"))
let container = ""
let admin: pg.Client | undefined
let server: Server | undefined
let base = ""

beforeAll(async () => {
  if (!dockerAvailable) return
  process.env["STORAGE_BACKEND"] = "file"
  process.env["STORAGE_FILE_PATH"] = root
  const pgStack = startPostgres()
  container = pgStack.container
  admin = await connectWhenReady(pgStack.url)
  await provision(admin)
  const started = await startService(pgStack.url, SECRET)
  server = started.server
  base = started.base
  const bucket = { name: BUCKET, public: true, allowed_mime_types: ["image/png"], file_size_limit: 64 * 1024 }
  const created = await call("POST", "/bucket", JSON.stringify(bucket), "application/json")
  if (created.status !== 200) throw new Error(`bucket not created: ${created.status} ${await created.text()}`)
}, 120_000)

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  if (server) await (await import("../src/db.js")).closePool()
  await admin?.end().catch(() => undefined)
  if (container) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" })
  rmSync(root, { recursive: true, force: true })
})

function call(method: string, path: string, body?: string | Buffer, contentType?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${SERVICE}`, ...(contentType !== undefined && { "content-type": contentType }) },
    ...(body !== undefined && { body }),
  })
}

/**
 * The status of an upload of `sent` bytes to the limited bucket that never sends the rest, or
 * of a chunked one that never ends; rejects when no answer comes within three seconds.
 */
function heldUpload(headers: Record<string, string>, sent: number): Promise<number> {
  const url = new URL(`${base}/object/${BUCKET}/held.png`)
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { authorization: `Bearer ${SERVICE}`, "content-type": "image/png", ...headers } })
    const timer = setTimeout(() => {
      req.destroy()
      reject(new Error("no answer before the body was complete"))
    }, 3_000)
    req.on("response", (res) => {
      clearTimeout(timer)
      res.resume()
      req.destroy()
      resolve(res.statusCode ?? 0)
    })
    req.on("error", () => undefined)
    req.write(Buffer.alloc(sent))
  })
}

/** Every file under the backend's root. */
function filesOnDisk(): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))
}

const png = (width: number): Promise<Buffer> =>
  sharp({ create: { width, height: width, channels: 3, background: "#2a7" } }).png().toBuffer()

describe.skipIf(!dockerAvailable)("the service on the file backend", () => {
  it("stores an upload on disk and serves it transformed by sharp", async () => {
    expect((await call("POST", `/object/${BUCKET}/cat.png`, await png(40), "image/png")).status).toBe(200)
    expect(filesOnDisk().some((path) => !path.endsWith(".type"))).toBe(true)
    const res = await fetch(`${base}/object/public/${BUCKET}/cat.png?width=8&format=webp`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/webp")
    expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width).toBe(8)
  })

  it("refuses a type the bucket does not accept, and a file over its size limit", async () => {
    expect((await call("POST", `/object/${BUCKET}/notes.txt`, "text", "text/plain")).status).toBe(415)
    expect((await call("POST", `/object/${BUCKET}/huge.png`, Buffer.alloc(65 * 1024), "image/png")).status).toBe(413)
  })

  // Local test round 3: the 413 came only after the whole body was read. Each request here sends
  // a little and then holds the rest back, so only an answer made before reading it all arrives.
  it("refuses an oversized upload from its Content-Length, before the body is read", async () => {
    expect(await heldUpload({ "content-length": String(65 * 1024) }, 1024)).toBe(413)
  })

  it("refuses a chunked upload once it passes the limit, without reading the rest", async () => {
    expect(await heldUpload({ "transfer-encoding": "chunked" }, 65 * 1024)).toBe(413)
  })

  // Local test round 3b: these were stored, and an out-of-range size limit answered 500.
  it.each([
    ["an id with a separator", { name: "a/b" }],
    ["the server store's own directory", { name: ".SUPATYPE" }],
    ["a 300-character id", { name: "x".repeat(300) }],
    ["a negative size limit", { name: "neg", file_size_limit: -1 }],
    ["a size limit out of range", { name: "huge", file_size_limit: 1e20 }],
    ["a junk MIME type", { name: "junk-mime", allowed_mime_types: ["not a type"] }],
    ["a junk policy", { name: "junk-policy", s3_bucket_policy: "allow everyone" }],
  ])("refuses a bucket with %s with 400", async (_why, bucket) => {
    expect((await call("POST", "/bucket", JSON.stringify(bucket), "application/json")).status).toBe(400)
  })

  it("refuses an update to a size limit it cannot hold with 400", async () => {
    expect((await call("PUT", `/bucket/${BUCKET}`, JSON.stringify({ file_size_limit: -5 }), "application/json")).status).toBe(400)
  })

  it("deletes the bytes from disk with the object", async () => {
    await call("POST", `/object/${BUCKET}/gone.png`, await png(4), "image/png")
    const before = filesOnDisk().length
    const removed = await call("DELETE", `/object/${BUCKET}`, JSON.stringify({ prefixes: ["gone.png"] }), "application/json")
    expect(removed.status).toBe(200)
    expect(filesOnDisk().length).toBe(before - 2)
    expect((await fetch(`${base}/object/public/${BUCKET}/gone.png`)).status).toBe(404)
  })
})
