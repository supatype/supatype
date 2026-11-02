import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { projectConfig } from "./support/project-config.js"

/** The Deno the cache holds, and whether it could be had at all. */
const deno = vi.hoisted(() => ({ available: true }))
vi.mock("../src/ensure-binary.js", async () => {
  const { cacheRoot } = await import("../src/binary-cache.js")
  const { join } = await import("node:path")
  return {
    ensureBinary: async () => {
      if (!deno.available) throw new Error("no deno for this platform")
      return join(cacheRoot(), "deno", "2.2.0", "deno")
    },
  }
})
// releases.supatype.com answering 504, as in local test round 5 (N25).
vi.mock("../src/binary-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/binary-cache.js")>()),
  resolveVersionFor: async () => {
    throw new Error("Failed to fetch latest version for deno: HTTP 504")
  },
}))

const { cacheRoot } = await import("../src/binary-cache.js")
const { nativeWorkerDenoEnv, prepareNativeWorker } = await import("../src/native-worker.js")
const cachedDeno = join(cacheRoot(), "deno", "2.2.0", "deno")

/**
 * Local test round 3d (N19): native dev started no functions worker in a project with no functions/
 * and no hooks/, and the server's environment is fixed at spawn, so the first hook declared while
 * dev ran answered 503 and the first function 404 until dev was restarted. The worker is set up on
 * every start, with or without a route yet.
 */
let cwd = ""
const logs: string[] = []

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-native-worker-"))
  deno.available = true
  logs.length = 0
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

describe("native dev's functions worker", () => {
  it("is set up in a project with no functions and no hooks yet, on the directories it would have", async () => {
    const worker = await prepareNativeWorker(cwd, projectConfig({ provider: "native" }))
    expect(worker).toMatchObject({ functionsDir: join(cwd, "functions"), hooksDir: join(cwd, "hooks"), routes: [], denoBin: cachedDeno })
    expect(existsSync(worker.entry)).toBe(true)
    expect(readFileSync(worker.entry, "utf8")).toContain(`import "file:///`)
    expect(logs.join("\n")).toContain("no functions or hooks yet; one added while dev runs is served")
  })

  it("names the routes it found", async () => {
    mkdirSync(join(cwd, "hooks", "audit"), { recursive: true })
    writeFileSync(join(cwd, "hooks", "audit", "index.ts"), "export default () => new Response('ok')\n")
    const worker = await prepareNativeWorker(cwd, projectConfig({ provider: "native" }))
    expect(worker.routes).toEqual(["hooks/audit"])
    expect(readFileSync(worker.entry, "utf8")).toContain("// Routes: hooks/audit")
  })
})

/**
 * Local test round 5 (N25): with releases.supatype.com answering 504 and Deno cached, the cached
 * Deno was found, then the CDN asked again only to print its version, and that failure turned
 * functions and hooks off. The server, given no Deno, then ran the one on PATH anyway.
 */
describe("native dev's Deno while the release CDN fails", () => {
  it("runs the cached Deno, naming its version without asking the CDN", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const worker = await prepareNativeWorker(cwd, projectConfig({ provider: "native" }))
    expect(worker.denoBin).toBe(cachedDeno)
    expect(logs.join("\n")).toContain(`Deno runtime: ${cachedDeno} (v2.2.0)`)
  })

  it("tells the server to run no Deno when none could be provisioned", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    deno.available = false
    const worker = await prepareNativeWorker(cwd, projectConfig({ provider: "native" }))
    expect(worker.denoBin).toBeUndefined()
    // Unset, the server's default is `deno` from PATH; empty is none.
    expect(nativeWorkerDenoEnv(worker)).toEqual({ SUPATYPE_DENO_PATH: "" })
  })

  it("tells the server which Deno to run", async () => {
    const worker = await prepareNativeWorker(cwd, projectConfig({ provider: "native" }))
    expect(nativeWorkerDenoEnv(worker)).toEqual({ SUPATYPE_DENO_PATH: cachedDeno })
  })
})
