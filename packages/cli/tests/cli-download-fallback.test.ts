import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PlatformId } from "../src/binary-cache.js"

/**
 * The CLI archive is fetched from releases.supatype.com, then from GitHub Releases when the CDN
 * cannot answer. fetch is mocked: no test touches the network.
 */
const VERSION = "9.9.9"
const PLATFORM: PlatformId = { os: "linux", arch: "amd64" }
const NAME = "supatype-cli-linux-amd64.tar.gz"
const BODY = Buffer.from("pretend archive bytes")
const DIGEST = createHash("sha256").update(BODY).digest("hex")
const CDN = `https://releases.supatype.com/cli/v${VERSION}`
const GITHUB = `https://github.com/supatype/supatype/releases/download/v${VERSION}`

type Route = { status: number } | { body: Buffer } | "network"

let routes: Map<string, Route>
let requested: string[]
let dir: string
let stderr: string[]

function respond(route: Exclude<Route, "network">): Response {
  if ("status" in route) return new Response(null, { status: route.status })
  return new Response(new Uint8Array(route.body), { status: 200 })
}

function serve(host: string, manifestBody: string, archive: Route): void {
  routes.set(`${host}/checksums.sha256`, { body: Buffer.from(manifestBody) })
  routes.set(`${host}/${NAME}`, archive)
}

const goodManifest = `${DIGEST}  ${NAME}\n`

beforeEach(() => {
  routes = new Map()
  requested = []
  stderr = []
  dir = mkdtempSync(join(tmpdir(), "cli-fallback-"))
  vi.resetModules()
  vi.stubEnv("SUPATYPE_RETRY_DELAY_MS", "1")
  vi.stubEnv("SUPATYPE_ALLOW_UNVERIFIED_DOWNLOADS", "1")
  vi.stubEnv("SUPATYPE_CDN_BASE", "")
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      const route = routes.get(url) ?? { status: 404 }
      if (route === "network") throw new TypeError("fetch failed")
      return respond(route)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

async function download(): Promise<string> {
  const { fetchVerifiedArchive } = await import("../src/cli-standalone.js")
  const archivePath = join(dir, NAME)
  await fetchVerifiedArchive(VERSION, PLATFORM, "glibc", archivePath)
  return archivePath
}

const fellBack = (): boolean => stderr.some((l) => l.includes("GitHub Releases instead"))
const askedGithub = (): boolean => requested.some((u) => u.startsWith(GITHUB))

describe("CLI download fallback", () => {
  it("does not touch GitHub when the CDN answers", async () => {
    serve(CDN, goodManifest, { body: BODY })
    await download()
    expect(askedGithub()).toBe(false)
    expect(fellBack()).toBe(false)
  })

  it("falls back to GitHub Releases on a 503, verifies the file and says so", async () => {
    routes.set(`${CDN}/checksums.sha256`, { status: 503 })
    routes.set(`${CDN}/${NAME}`, { status: 503 })
    serve(GITHUB, goodManifest, { body: BODY })
    const path = await download()
    expect(readFileSync(path).equals(BODY)).toBe(true)
    expect(requested).toContain(`${GITHUB}/checksums.sha256`)
    expect(requested).toContain(`${GITHUB}/${NAME}`)
    expect(stderr.filter((l) => l.includes("GitHub Releases instead"))).toHaveLength(1)
  })

  it("falls back when the CDN cannot be reached at all", async () => {
    routes.set(`${CDN}/checksums.sha256`, "network")
    routes.set(`${CDN}/${NAME}`, "network")
    serve(GITHUB, goodManifest, { body: BODY })
    await download()
    expect(askedGithub()).toBe(true)
    expect(fellBack()).toBe(true)
  })

  it("does not fall back on a 404", async () => {
    // Nothing is routed, so the CDN answers 404 for everything.
    serve(GITHUB, goodManifest, { body: BODY })
    await expect(download()).rejects.toThrow(/HTTP 404/)
    expect(askedGithub()).toBe(false)
    expect(fellBack()).toBe(false)
  })

  it("does not fall back on a checksum mismatch", async () => {
    serve(CDN, `${"0".repeat(64)}  ${NAME}\n`, { body: BODY })
    serve(GITHUB, goodManifest, { body: BODY })
    await expect(download()).rejects.toThrow(/Checksum mismatch/)
    expect(askedGithub()).toBe(false)
    expect(fellBack()).toBe(false)
  })

  it("rejects a GitHub file that fails its checksum", async () => {
    routes.set(`${CDN}/checksums.sha256`, { status: 503 })
    routes.set(`${CDN}/${NAME}`, { status: 503 })
    serve(GITHUB, `${"0".repeat(64)}  ${NAME}\n`, { body: BODY })
    await expect(download()).rejects.toThrow(/Checksum mismatch/)
    expect(fellBack()).toBe(true)
  })

  it("downloads cleanly from GitHub after the CDN served a manifest but not the archive", async () => {
    serve(CDN, goodManifest, { status: 503 })
    serve(GITHUB, goodManifest, { body: BODY })
    const path = await download()
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path).equals(BODY)).toBe(true)
  })

  it("keeps SUPATYPE_CDN_BASE a choice: a failing mirror is not replaced by GitHub", async () => {
    vi.stubEnv("SUPATYPE_CDN_BASE", "https://mirror.example/")
    routes.set("https://mirror.example/cli/v9.9.9/checksums.sha256", { status: 503 })
    routes.set(`https://mirror.example/cli/v9.9.9/${NAME}`, { status: 503 })
    serve(GITHUB, goodManifest, { body: BODY })
    await expect(download()).rejects.toThrow(/HTTP 503/)
    expect(askedGithub()).toBe(false)
    expect(fellBack()).toBe(false)
  })
})
