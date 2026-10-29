import { createServer, type IncomingMessage, type Server } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isJsonObject } from "@supatype/shared"
import { IMPORTED_MARKER, importLegacyNativeStorage } from "../src/native-storage-import.js"
import { serverStorageEnv, startNativeStorage, type NativeStorageOptions } from "../src/native-storage.js"
import { ProcessManager } from "../src/process-manager.js"
import { parseJsonAs } from "./support/json.js"
import { projectConfig } from "./support/project-config.js"

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
}

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString()
}

/** A storage service stand-in on a free port, answering `status(req)` and recording what came in. */
async function fakeStorage(status: (path: string) => number = () => 200): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = []
  const server = createServer(async (req, res) => {
    const path = req.url ?? ""
    received.push({ method: req.method ?? "", path, contentType: req.headers["content-type"], authorization: req.headers.authorization, body: await read(req) })
    res.writeHead(path === "/health" ? 200 : status(path), { "content-type": "application/json" })
    res.end(path === "/health" ? '{"status":"ok"}' : "{}")
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received }
}

/** The server's object store as it left a project: one bucket, one object with its sidecar. */
function legacyStore(): string {
  const root = join(dir, "state", "storage")
  mkdirSync(join(root, ".supatype"), { recursive: true })
  writeFileSync(join(root, ".supatype", "buckets.json"), JSON.stringify([{ id: "avatars", name: "avatars", public: true, access_mode: "public" }]))
  mkdirSync(join(root, "avatars", "me"), { recursive: true })
  writeFileSync(join(root, "avatars", "me", "pic.png"), "png bytes")
  mkdirSync(join(root, "avatars", ".meta", "me"), { recursive: true })
  const owner = "0b5c3a52-2d3f-4d0e-9a39-0f6b3c1d2e4f"
  writeFileSync(join(root, "avatars", ".meta", "me", "pic.png.json"), JSON.stringify({ name: "me/pic.png", content_type: "image/png", owner }))
  return root
}

/** The `sub` of a bearer token. */
function subjectOf(authorization: string | undefined): unknown {
  const payload = authorization?.split(" ")[1]?.split(".")[1] ?? ""
  return parseJsonAs(Buffer.from(payload, "base64url").toString(), isJsonObject)["sub"]
}

describe("the one-time import of the server's object store", () => {
  it("creates its buckets and uploads its objects with their type and owner, then records it", async () => {
    const root = legacyStore()
    const service = await fakeStorage()
    await importLegacyNativeStorage({ legacyRoot: root, url: service.url, jwtSecret: "secret" })
    expect(service.received.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /bucket", "POST /object/avatars/me/pic.png"])
    const upload = service.received[1]
    expect(upload).toMatchObject({ contentType: "image/png", body: "png bytes" })
    expect(subjectOf(upload?.authorization)).toBe("0b5c3a52-2d3f-4d0e-9a39-0f6b3c1d2e4f")
    expect(existsSync(join(root, IMPORTED_MARKER))).toBe(true)
    expect(readFileSync(join(root, "avatars", "me", "pic.png"), "utf8")).toBe("png bytes")
  })

  it("uploads objects once, and still creates the buckets a push declared since", async () => {
    const root = legacyStore()
    await importLegacyNativeStorage({ legacyRoot: root, url: (await fakeStorage()).url, jwtSecret: "secret" })
    const again = await fakeStorage()
    await importLegacyNativeStorage({ legacyRoot: root, url: again.url, jwtSecret: "secret" })
    expect(again.received.map((r) => r.path)).toEqual(["/bucket"])
  })

  it("counts an object the service already holds as imported", async () => {
    const root = legacyStore()
    const service = await fakeStorage((path) => (path.startsWith("/object/") ? 409 : 200))
    await importLegacyNativeStorage({ legacyRoot: root, url: service.url, jwtSecret: "secret" })
    expect(existsSync(join(root, IMPORTED_MARKER))).toBe(true)
  })

  it("fails, records nothing and leaves the store as it was, when an object is refused", async () => {
    const root = legacyStore()
    const service = await fakeStorage((path) => (path.startsWith("/object/") ? 500 : 200))
    await expect(importLegacyNativeStorage({ legacyRoot: root, url: service.url, jwtSecret: "secret" })).rejects.toThrow(/avatars\/me\/pic.png/)
    expect(existsSync(join(root, IMPORTED_MARKER))).toBe(false)
    expect(existsSync(join(root, "avatars", "me", "pic.png"))).toBe(true)
  })
})

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

/** A port nothing listens on yet. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise((resolve) => server.close(resolve))
  return port
}

describe("startNativeStorage", () => {
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
