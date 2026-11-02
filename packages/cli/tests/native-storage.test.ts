import { createServer, type IncomingMessage, type Server } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isArrayOf, isJsonObject } from "@supatype/shared"
import { IMPORTED_MARKER, importLegacyNativeStorage } from "../src/native-storage-import.js"
import { serverStorageEnv, startNativeStorage, waitForStorageReady, type NativeStorageOptions } from "../src/native-storage.js"
import { drainStartUndo, resetDevShutdownForTests } from "../src/dev-shutdown.js"
import { ProcessManager, readPid } from "../src/process-manager.js"
import { parseJsonAs } from "./support/json.js"
import { freePort, portOf } from "./support/ports.js"
import { projectConfig } from "./support/project-config.js"

/** Every file the import read as JSON, so a test can see which sidecars it opened. */
const jsonReads = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock("../src/json-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/json-file.js")>()
  return {
    ...actual,
    readJsonFile: <T>(path: string, guard: (value: unknown) => value is T): T | undefined => {
      jsonReads.paths.push(path)
      return actual.readJsonFile(path, guard)
    },
  }
})

/**
 * Native dev runs the storage service (packages/storage) instead of the server's built-in object
 * store, so bucket rules and image transforms come from the code a deployment runs. The server is
 * pointed at the service only once it answers, and what the server's store held is imported first:
 * until that import has gone through, the server's store keeps answering, so nothing goes missing.
 */
let dir = ""
const servers: Server[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-native-storage-"))
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
  rmSync(dir, { recursive: true, force: true })
})

/** A request the fake storage service received: method, path, headers and body. */
interface Received {
  method: string
  path: string
  contentType: string | undefined
  authorization: string | undefined
  body: string
  /** Whether it was sent with `x-upsert: true`. */
  upsert: boolean
}

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const piece: unknown = chunk
    chunks.push(Buffer.isBuffer(piece) ? piece : Buffer.from(String(piece)))
  }
  return Buffer.concat(chunks).toString()
}

/**
 * A storage service stand-in on a free port, answering `status(path, sent)` with `body(path, sent)`,
 * where `sent` is the request body, and recording what came in.
 */
async function fakeStorage(
  status: (path: string, sent: string) => number = () => 200,
  body: (path: string, sent: string) => string = () => "{}",
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = []
  const server = createServer(async (req, res) => {
    const path = req.url ?? ""
    const sent = await read(req)
    const upsert = req.headers["x-upsert"] === "true"
    received.push({ method: req.method ?? "", path, contentType: req.headers["content-type"], authorization: req.headers.authorization, body: sent, upsert })
    res.writeHead(path === "/health" ? 200 : status(path, sent), { "content-type": "application/json" })
    res.end(path === "/health" ? '{"status":"ok"}' : body(path, sent))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${portOf(server)}`, received }
}

/** Sets a file's modified time `seconds` from now, so the import's time comparison is not a race. */
function touch(path: string, seconds: number): void {
  const at = Date.now() / 1000 + seconds
  utimesSync(path, at, at)
}

/** An object in the store, its bytes and its sidecar, written `seconds` from now. */
function writeObject(root: string, bucket: string, name: string, body: string, seconds: number): void {
  const file = join(root, bucket, ...name.split("/"))
  const meta = `${join(root, bucket, ".meta", ...name.split("/"))}.json`
  mkdirSync(dirname(file), { recursive: true })
  mkdirSync(dirname(meta), { recursive: true })
  writeFileSync(file, body)
  writeFileSync(meta, JSON.stringify({ name, content_type: "image/png", owner: "0b5c3a52-2d3f-4d0e-9a39-0f6b3c1d2e4f" }))
  touch(file, seconds)
  touch(meta, seconds)
}

/** The server's object store as it left a project an hour ago: one bucket, one object with its sidecar. */
function legacyStore(): string {
  const root = join(dir, "state", "storage")
  mkdirSync(join(root, ".supatype"), { recursive: true })
  writeFileSync(join(root, ".supatype", "buckets.json"), JSON.stringify([{ id: "avatars", name: "avatars", public: true, access_mode: "public" }]))
  writeObject(root, "avatars", "me/pic.png", "png bytes", -3600)
  return root
}

/** The `sub` of a bearer token. */
function subjectOf(authorization: string | undefined): unknown {
  const payload = authorization?.split(" ")[1]?.split(".")[1] ?? ""
  return parseJsonAs(Buffer.from(payload, "base64url").toString(), isJsonObject)["sub"]
}

/** Runs the import as CLI `cliVersion` would, against a fresh stand-in service answering `status`. */
async function importAs(
  root: string,
  cliVersion: string,
  status?: (path: string, sent: string) => number,
  body?: (path: string, sent: string) => string,
): Promise<Received[]> {
  const service = await fakeStorage(status, body)
  await importLegacyNativeStorage({ legacyRoot: root, url: service.url, jwtSecret: "secret", cliVersion })
  return service.received
}

/** The store with a second bucket, `bad`, holding one object, and a service that answers `code` for `bad`. */
function storeWithBadBucket(code: number): { root: string; status: (path: string, sent: string) => number } {
  const root = legacyStore()
  const rows = [{ id: "avatars", name: "avatars", public: true }, { id: "bad", name: "bad", public: false, file_size_limit: 1e20 }]
  writeFileSync(join(root, ".supatype", "buckets.json"), JSON.stringify(rows))
  writeObject(root, "bad", "kept.png", "kept", -3600)
  const isBad = (path: string, sent: string): boolean => (path === "/bucket" && sent.includes('"bad"')) || path.startsWith("/object/bad/")
  return { root, status: (path, sent) => (!isBad(path, sent) ? 200 : path === "/bucket" ? code : 404) }
}

const uploadsIn = (received: Received[]): string[] => received.filter((r) => r.path.startsWith("/object/")).map((r) => r.path)
const markerOf = (root: string): Record<string, unknown> => parseJsonAs(readFileSync(join(root, IMPORTED_MARKER), "utf8"), isJsonObject)

describe("the import of the server's object store", () => {
  it("creates its buckets and uploads its objects with their type and owner, then records it", async () => {
    const root = legacyStore()
    const received = await importAs(root, "0.7.0")
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /bucket", "POST /object/avatars/me/pic.png"])
    expect(received[1]).toMatchObject({ contentType: "image/png", body: "png bytes", upsert: false })
    expect(subjectOf(received[1]?.authorization)).toBe("0b5c3a52-2d3f-4d0e-9a39-0f6b3c1d2e4f")
    expect(existsSync(join(root, IMPORTED_MARKER))).toBe(true)
    expect(readFileSync(join(root, "avatars", "me", "pic.png"), "utf8")).toBe("png bytes")
  })

  // Nic's decision on round 3 D2: only what changed since the last import is sent, so an object
  // deleted in the service after it was imported is not put back from the old store.
  it("does not bring back an object deleted in the service since it was imported, and still creates buckets", async () => {
    const root = legacyStore()
    await importAs(root, "0.7.0")
    expect((await importAs(root, "0.7.0")).map((r) => r.path)).toEqual(["/bucket"])
  })

  // Local test round 3 N8: native dev falls back to the server's store whenever the service fails to
  // start, and what it took then was never imported, because the import was recorded as done for good.
  it("imports at the next start an object the server's store took after the import", async () => {
    const root = legacyStore()
    await importAs(root, "0.7.0")
    writeObject(root, "avatars", "notes.txt", "later", 5)
    const received = await importAs(root, "")
    expect(received.filter((r) => r.path.startsWith("/object/")).map((r) => `${r.path} ${r.body}`)).toEqual(["/object/avatars/notes.txt later"])
    // The release that first imported is kept, since the old store goes one release after it.
    expect(markerOf(root)).toMatchObject({ complete: true, cli_version: "0.7.0", last_import_cli_version: "", last_import_objects: 1 })
    expect(readFileSync(join(root, "avatars", "notes.txt"), "utf8")).toBe("later")
  })

  // A start reads the sidecar only of an object that changed since the last import.
  it("reads no sidecar of an object unchanged since the last import", async () => {
    const root = legacyStore()
    await importAs(root, "0.7.0")
    jsonReads.paths.length = 0
    await importAs(root, "0.7.0")
    expect(jsonReads.paths.filter((path) => path.includes(".meta"))).toEqual([])
  })

  it("imports a file changed after the last import over the service's copy", async () => {
    const root = legacyStore()
    await importAs(root, "0.7.0")
    writeObject(root, "avatars", "me/pic.png", "new bytes", 5)
    const upload = (await importAs(root, "0.7.0")).find((r) => r.path === "/object/avatars/me/pic.png")
    expect(upload).toMatchObject({ body: "new bytes", upsert: true })
  })

  it("counts an object the service already holds as imported", async () => {
    const root = legacyStore()
    await importAs(root, "0.7.0", (path) => (path.startsWith("/object/") ? 409 : 200))
    expect(markerOf(root)).toMatchObject({ complete: true, skipped: [] })
  })

  // An object the service refuses (its bucket's type or size rule, say) used to fail the whole
  // import, which kept the server's store answering on every start.
  it("skips an object the service refuses, says so once, and records it", async () => {
    const root = legacyStore()
    writeObject(root, "avatars", "big.png", "too big", -3600)
    const warn = vi.spyOn(console, "warn")
    const refused = (path: string): number => (path === "/object/avatars/big.png" ? 413 : 200)
    expect(uploadsIn(await importAs(root, "0.7.0", refused))).toEqual(["/object/avatars/big.png", "/object/avatars/me/pic.png"])
    expect(warn.mock.calls.flat().filter((line) => String(line).includes("avatars/big.png (HTTP 413"))).toHaveLength(1)
    expect(markerOf(root)).toMatchObject({ skipped: [{ id: "avatars/big.png", status: 413 }] })
    // Not tried again until its file changes.
    expect(uploadsIn(await importAs(root, "0.7.0", refused))).toEqual([])
    // Changed and taken, it is no longer recorded as skipped, so the old store's removal does not keep it.
    writeObject(root, "avatars", "big.png", "smaller", 5)
    expect(uploadsIn(await importAs(root, "0.7.0"))).toEqual(["/object/avatars/big.png"])
    expect(markerOf(root)).toMatchObject({ skipped: [] })
  })

  // Local test round 3b N14: a bucket the service refused failed the whole import, so the server's
  // store answered on every start while the service ran.
  it("skips a bucket the service refuses, keeps its objects, and imports the rest", async () => {
    const { root, status } = storeWithBadBucket(400)
    const warn = vi.spyOn(console, "warn")
    expect(uploadsIn(await importAs(root, "0.7.0", status))).toContain("/object/avatars/me/pic.png")
    expect(warn.mock.calls.flat().filter((line) => String(line).includes("bad (HTTP 400"))).toHaveLength(1)
    expect(markerOf(root)).toMatchObject({ skipped_buckets: [{ id: "bad", status: 400 }], skipped: [{ id: "bad/kept.png", status: 404 }] })
    // Taken at a later start, the bucket's objects go with it, though their files did not change.
    expect(uploadsIn(await importAs(root, "0.7.0"))).toEqual(["/object/bad/kept.png"])
    expect(markerOf(root)).toMatchObject({ skipped_buckets: [], skipped: [] })
  })

  // Local test round 3c: a refusal was named by its status only, `r3chuge (400)`.
  it("names the service's reason for a refused bucket and object, and records it", async () => {
    const { root, status } = storeWithBadBucket(400)
    const reason = (path: string): string =>
      JSON.stringify({ error: path === "/bucket" ? "file_size_limit is out of range" : "Bucket not found" })
    const warn = vi.spyOn(console, "warn")
    await importAs(root, "0.7.0", status, reason)
    const said = warn.mock.calls.flat().map(String).join("\n")
    expect(said).toContain("bad (HTTP 400 Bad Request: file_size_limit is out of range)")
    expect(said).toContain("bad/kept.png (HTTP 404 Not Found: Bucket not found)")
    expect(markerOf(root)).toMatchObject({
      skipped_buckets: [{ id: "bad", status: 400, reason: "HTTP 400 Bad Request: file_size_limit is out of range" }],
    })
  })

  // Local test round 3c: the refused-bucket warning repeated on every start.
  it("warns of a refused bucket once, and again only when its refusal or its row changes", async () => {
    const { root, status } = storeWithBadBucket(400)
    const warn = vi.spyOn(console, "warn")
    const bucketWarnings = (): number => warn.mock.calls.flat().filter((line) => String(line).includes("bucket(s)")).length
    await importAs(root, "0.7.0", status)
    await importAs(root, "0.7.0", status)
    expect(bucketWarnings()).toBe(1)
    const rows = [{ id: "avatars", name: "avatars", public: true }, { id: "bad", name: "bad", public: false, file_size_limit: 2e20 }]
    writeFileSync(join(root, ".supatype", "buckets.json"), JSON.stringify(rows))
    await importAs(root, "0.7.0", status)
    expect(bucketWarnings()).toBe(2)
    await importAs(root, "0.7.0", status, () => '{"error":"another reason"}')
    expect(bucketWarnings()).toBe(3)
    await importAs(root, "0.7.0", status, () => '{"error":"another reason"}')
    expect(bucketWarnings()).toBe(3)
  })

  // The service answers 400 for a value it cannot hold, so any 5xx for a bucket is the service failing.
  it("fails the import when the service answers 5xx for a bucket, whatever the body says", async () => {
    const { root, status } = storeWithBadBucket(500)
    const outOfRange = (): string => '{"error":"value \\"1e+20\\" is out of range for type bigint"}'
    await expect(importAs(root, "0.7.0", status, outOfRange)).rejects.toThrow(/bad: HTTP 500/)
    expect(existsSync(join(root, IMPORTED_MARKER))).toBe(false)
  })

  // Review of round 3b: only a refusal of the object itself is permanent. Auth, a timeout or a rate
  // limit is the service, or this CLI's token, failing: the import is retried at the next start.
  it.each([401, 403, 408, 429])("fails the import, rather than skipping the object, when the service answers %i", async (code) => {
    const root = legacyStore()
    await expect(importAs(root, "0.7.0", (path) => (path.startsWith("/object/") ? code : 200))).rejects.toThrow(/not imported/)
    expect(existsSync(join(root, IMPORTED_MARKER))).toBe(false)
  })

  // Review of round 3c: the refused buckets were recorded only once every object went, so while the
  // objects failed, the bucket warning came again on every start.
  // Review: a bucket refused, then taken at a start whose objects then failed. That start recorded
  // the new refusals at once, so the next start no longer knew the bucket had just been taken, and
  // its objects, unchanged since, were never sent.
  it("sends a newly taken bucket's objects at the next start when the start that took it failed", async () => {
    const { root, status } = storeWithBadBucket(400)
    await importAs(root, "0.7.0", status)
    expect(markerOf(root)).toMatchObject({ skipped_buckets: [{ id: "bad" }] })
    const objectsFail = (path: string): number => (path.startsWith("/object/") ? 500 : 200)
    await expect(importAs(root, "0.7.0", objectsFail)).rejects.toThrow(/not imported/)
    expect(uploadsIn(await importAs(root, "0.7.0"))).toEqual(["/object/bad/kept.png"])
    expect(markerOf(root)).toMatchObject({ skipped_buckets: [], pending_buckets: [] })
  })

  it("records a refused bucket though the objects then fail, and warns of it once", async () => {
    const { root, status } = storeWithBadBucket(400)
    const objectsFail = (path: string, sent: string): number => (path.startsWith("/object/avatars/") ? 500 : status(path, sent))
    const warn = vi.spyOn(console, "warn")
    await expect(importAs(root, "0.7.0", objectsFail)).rejects.toThrow(/not imported/)
    await expect(importAs(root, "0.7.0", objectsFail)).rejects.toThrow(/not imported/)
    expect(warn.mock.calls.flat().filter((line) => String(line).includes("bucket(s)"))).toHaveLength(1)
    expect(markerOf(root)).toMatchObject({ complete: false, skipped_buckets: [{ id: "bad", status: 400 }] })
    // The import that then goes through is the first: it sends every object.
    expect(uploadsIn(await importAs(root, "0.7.0", status))).toContain("/object/avatars/me/pic.png")
    expect(markerOf(root)).toMatchObject({ complete: true, cli_version: "0.7.0" })
  })

  it("fails, records nothing and leaves the store as it was, when the service itself fails", async () => {
    const root = legacyStore()
    const failing = importAs(root, "0.7.0", (path) => (path.startsWith("/object/") ? 500 : 200))
    await expect(failing).rejects.toThrow(/avatars\/me\/pic.png/)
    expect(existsSync(join(root, IMPORTED_MARKER))).toBe(false)
    expect(existsSync(join(root, "avatars", "me", "pic.png"))).toBe(true)
  })
})

const oldStoreKept = (root: string): boolean =>
  existsSync(join(root, "avatars", "me", "pic.png")) && existsSync(join(root, ".supatype", "buckets.json"))

describe("the old store, after the import", () => {
  it("is kept by the release that imported it", async () => {
    const root = legacyStore()
    await importAs(root, "0.7.0")
    await importAs(root, "0.7.0")
    expect(oldStoreKept(root)).toBe(true)
  })

  it("is removed by a later release, what changed since imported first, saying what went", async () => {
    const root = legacyStore()
    await importAs(root, "0.7.0")
    writeObject(root, "avatars", "me/pic.png", "new bytes", 5)
    const log = vi.spyOn(console, "log")
    expect(uploadsIn(await importAs(root, "0.8.0"))).toContain("/object/avatars/me/pic.png")
    expect(existsSync(join(root, "avatars"))).toBe(false)
    expect(existsSync(join(root, ".supatype", "buckets.json"))).toBe(false)
    expect(log.mock.calls.flat().join("\n")).toMatch(/Removed the server's old object store, imported into the storage service by v0\.7\.0/)
    expect(markerOf(root)).toMatchObject({ old_store_removed: true })
  })

  // Nic's decision: an object the service refused was never imported, so its files are kept when
  // the old store goes, and everything else is removed.
  it("is removed except for the objects the service refused, saying how many were kept and where", async () => {
    const root = legacyStore()
    writeObject(root, "avatars", "docs/big.png", "too big", -3600)
    writeObject(root, "other", "gone.png", "gone", -3600)
    await importAs(root, "0.7.0", (path) => (path === "/object/avatars/docs/big.png" ? 413 : 200))
    const log = vi.spyOn(console, "log")
    await importAs(root, "0.8.0")
    expect(readFileSync(join(root, "avatars", "docs", "big.png"), "utf8")).toBe("too big")
    expect(existsSync(join(root, "avatars", ".meta", "docs", "big.png.json"))).toBe(true)
    expect(existsSync(join(root, "avatars", "me"))).toBe(false)
    expect(existsSync(join(root, "avatars", ".meta", "me"))).toBe(false)
    expect(existsSync(join(root, "other"))).toBe(false)
    expect(existsSync(join(root, ".supatype", "buckets.json"))).toBe(false)
    const kept = log.mock.calls.flat().map(String).filter((line) => line.includes("Kept 1 object"))
    expect(kept).toEqual([`[supatype] Kept 1 object(s) the storage service refused, in ${root}: avatars/docs/big.png`])
    expect(markerOf(root)).toMatchObject({ old_store_removed: true, skipped: [{ id: "avatars/docs/big.png", status: 413 }] })
  })

  // Review of round 3b: a bucket the service refused lost its buckets.json row with the old store,
  // so its kept objects had no bucket a later import could create.
  it("keeps the buckets.json rows of the buckets the service refused", async () => {
    const { root, status } = storeWithBadBucket(400)
    await importAs(root, "0.7.0", status)
    await importAs(root, "0.8.0", status)
    expect(markerOf(root)).toMatchObject({ old_store_removed: true })
    const rows = parseJsonAs(readFileSync(join(root, ".supatype", "buckets.json"), "utf8"), isArrayOf(isJsonObject))
    expect(rows.map((row) => row["id"])).toEqual(["bad"])
    expect(existsSync(join(root, "bad", "kept.png"))).toBe(true)
  })

  // Review of round 3c: the removal named the objects it kept, but not the buckets that stayed out.
  it("names the buckets the service refused when it removes the store", async () => {
    const { root, status } = storeWithBadBucket(400)
    const said = vi.spyOn(console, "log")
    await importAs(root, "0.7.0", status, () => '{"error":"file_size_limit is out of range"}')
    await importAs(root, "0.8.0", status, () => '{"error":"file_size_limit is out of range"}')
    const lines = said.mock.calls.flat().map(String)
    expect(lines.find((line) => line.includes("bucket(s) the storage service refused"))).toContain(
      "bad (HTTP 400 Bad Request: file_size_limit is out of range)",
    )
  })

  it("is kept by a source build, which has no release to compare", async () => {
    const root = legacyStore()
    await importAs(root, "0.7.0")
    await importAs(root, "")
    expect(oldStoreKept(root)).toBe(true)
  })

  it("is kept when the import was made by a source build", async () => {
    const root = legacyStore()
    await importAs(root, "")
    await importAs(root, "0.8.0")
    expect(oldStoreKept(root)).toBe(true)
  })

  it("is kept by an older release", async () => {
    const root = legacyStore()
    await importAs(root, "0.8.0")
    await importAs(root, "0.7.0")
    expect(oldStoreKept(root)).toBe(true)
  })

  it("is kept when there is no marker: the later release imports instead", async () => {
    const root = legacyStore()
    expect(uploadsIn(await importAs(root, "0.8.0"))).toContain("/object/avatars/me/pic.png")
    expect(oldStoreKept(root)).toBe(true)
  })

  it.each([
    ["partial", JSON.stringify({ imported_at: "2026-10-29T00:00:00Z" })],
    ["incomplete", JSON.stringify({ complete: false, cli_version: "0.7.0" })],
    ["unreadable", "{ not json"],
  ])("is kept when the marker is %s, which is no marker", async (_kind, text) => {
    const root = legacyStore()
    writeFileSync(join(root, IMPORTED_MARKER), text)
    await importAs(root, "0.8.0")
    expect(oldStoreKept(root)).toBe(true)
  })

  it("is kept when importing what changed first fails", async () => {
    const root = legacyStore()
    await importAs(root, "0.7.0")
    writeObject(root, "avatars", "me/pic.png", "new bytes", 5)
    await expect(importAs(root, "0.8.0", (path) => (path.startsWith("/object/") ? 500 : 200))).rejects.toThrow(/not imported/)
    expect(oldStoreKept(root)).toBe(true)
  })
})

/** Whether a process with `pid` is running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function options(port: number): NativeStorageOptions {
  return {
    config: projectConfig(),
    cwd: dir,
    manifestPath: join(dir, "routes.json"),
    pidDir: dir,
    stateRoot: join(dir, "state"),
    port,
    databaseUrl: "postgres://localhost/none",
    jwtSecret: "secret",
  }
}

const manifest = (): Record<string, unknown> => parseJsonAs(readFileSync(join(dir, "routes.json"), "utf8"), isJsonObject)

/** A launch that runs a tiny health server on `port`, as the storage service answers /health. */
function healthyLaunch(port: number): { bin: string; args: string[] } {
  const script = `require("node:http").createServer((q, s) => { s.writeHead(200); s.end('{"status":"ok"}') }).listen(${port}, "127.0.0.1")`
  return { bin: process.execPath, args: ["-e", script] }
}

describe("startNativeStorage", () => {
  // Nic's decision on round 3b: a Ctrl+C while the service is still starting stops it too, so its
  // undo is recorded the moment it is spawned, not once it reports ready.
  it("is stopped by an interrupted start while it still waits for the service to be ready", async () => {
    const neverReady = { bin: process.execPath, args: ["-e", "setInterval(() => undefined, 1000)"] }
    const started = startNativeStorage(options(await freePort()), async () => neverReady)
    let pid: number | null = null
    for (let i = 0; i < 50 && pid === null; i++) {
      await new Promise((done) => setTimeout(done, 100))
      pid = readPid(dir, "storage")
    }
    expect(pid).not.toBeNull()
    expect(await drainStartUndo()).toEqual([])
    expect(await started).toBeNull()
    expect(alive(pid ?? 0)).toBe(false)
    resetDevShutdownForTests()
  }, 30_000)

  it("names the service in the route manifest once it answers /health", async () => {
    const port = await freePort()
    const storage = await startNativeStorage(options(port), async () => healthyLaunch(port))
    try {
      expect(storage?.url).toBe(`http://127.0.0.1:${port}`)
      expect(manifest()["storage_url"]).toBe(`http://127.0.0.1:${port}`)
    } finally {
      await storage?.proc.stop()
    }
  }, 30_000)

  // A release whose sharp cannot load exits at once; dev used to wait out the whole minute first.
  it("gives up as soon as the service exits before it is ready, not after the timeout", async () => {
    const crashing = { bin: process.execPath, args: ["-e", "process.exit(3)"] }
    const started = Date.now()
    expect(await startNativeStorage(options(await freePort()), async () => crashing)).toBeNull()
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 20_000)

  it("leaves the server's own store answering when the service cannot be found", async () => {
    writeFileSync(join(dir, "routes.json"), JSON.stringify({ storage_url: "http://127.0.0.1:1" }))
    const missing = async (): Promise<never> => {
      throw new Error("storage archive not available")
    }
    expect(await startNativeStorage(options(await freePort()), missing)).toBeNull()
    expect(manifest()).toEqual({})
  })
})

// Review of round 3b: the wait for the service counted wall-clock time, so a stretch in which a
// synchronous spawn held the event loop used up the minute without a single /health asked.
describe("the wait for the storage service to be ready", () => {
  it("does not count time the event loop was held", async () => {
    let asked = 0
    const server = createServer((_req, res) => {
      asked++
      res.writeHead(asked < 3 ? 503 : 200, { "content-type": "application/json" })
      res.end(asked < 3 ? "{}" : '{"status":"ok"}')
    })
    servers.push(server)
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    // A clock that jumps two minutes after the first ask, as if the loop had been held that long.
    let jumped = 0
    const now = (): number => Date.now() + jumped
    const held = (): boolean => {
      if (asked === 1) jumped = 120_000
      return false
    }
    await expect(waitForStorageReady(`http://127.0.0.1:${portOf(server)}`, held, { timeoutMs: 60_000, now })).resolves.toBeUndefined()
    expect(asked).toBe(3)
  })
})

describe("the server's storage environment", () => {
  const config = projectConfig()

  it("proxies to the service when it runs", () => {
    const proc = new ProcessManager(process.execPath, [], { label: "storage", pidDir: dir })
    expect(serverStorageEnv({ proc, url: "http://127.0.0.1:8002" }, config, "/state")).toEqual({
      SUPATYPE_STORAGE_URL: "http://127.0.0.1:8002",
    })
  })

  it("falls back to the server's own store under the state directory when it does not", () => {
    expect(serverStorageEnv(null, config, "/state")).toMatchObject({ STORAGE_PROVIDER: "local" })
  })
})
