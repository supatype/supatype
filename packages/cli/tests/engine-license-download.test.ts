import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let fakeHome = ""

// The cache lives under the home directory; every test here gets its own, never the real one.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => (fakeHome.length > 0 ? fakeHome : actual.homedir()) }
})

// These releases are unsigned, so the CLI must hold no release key. Clearing the environment
// variable is not enough: the npm publish job builds the real key into the CLI before it runs the
// tests, and the CLI falls back to that key, so the download then demands a signature.
vi.mock("../src/release-public-key.js", () => ({ releasePublicKey: () => "" }))

import { cachePath, currentPlatform, download, type PlatformId } from "../src/binary-cache.js"

/**
 * The engine is BUSL-1.1, and its release ships the LICENSE beside the binaries, listed in the same
 * signed checksums. The CLI downloaded the binary and left the licence behind, so a machine running
 * the engine had no copy of the terms it runs under.
 */
// This machine's platform: the "already cached" check reads the binary's magic bytes for it.
const PLATFORM: PlatformId = currentPlatform()
const VERSION = "9.9.9"
const MAGIC: Record<PlatformId["os"], number[]> = {
  linux: [0x7f, 0x45, 0x4c, 0x46],
  windows: [0x4d, 0x5a, 0x90, 0x00],
  darwin: [0xcf, 0xfa, 0xed, 0xfe],
}
const BINARY = Buffer.concat([Buffer.from(MAGIC[PLATFORM.os]), Buffer.alloc(124, 1)])
const LICENSE = "Business Source License 1.1\n\nLicensor: Supatype Ltd\n"
const EXE = PLATFORM.os === "windows" ? ".exe" : ""
const binaryName = (component: string): string => `supatype-${component}-${PLATFORM.os}-${PLATFORM.arch}${EXE}`

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex")

type Release = { manifestListsLicense: boolean; licenseBody: string | null }

function stubRelease(release: Release): string[] {
  const requested: string[] = []
  const lines = ["engine", "realtime"].map((component) => `${sha256(BINARY)}  ${binaryName(component)}`)
  if (release.manifestListsLicense) lines.push(`${sha256(LICENSE)}  LICENSE`)
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input)
    requested.push(url)
    if (url.endsWith("/checksums.sha256")) return new Response(`${lines.join("\n")}\n`)
    if (url.endsWith(`/${binaryName("engine")}`) || url.endsWith(`/${binaryName("realtime")}`)) {
      return new Response(BINARY)
    }
    if (url.endsWith("/LICENSE") && release.licenseBody !== null) return new Response(release.licenseBody)
    return new Response("not found", { status: 404 })
  })
  return requested
}

let logs: string[] = []
let warnings: string[] = []

beforeEach(() => {
  fakeHome = join(tmpdir(), `supatype-engine-license-${process.pid}-${Date.now()}`)
  mkdirSync(fakeHome, { recursive: true })
  vi.stubEnv("SUPATYPE_ALLOW_UNVERIFIED_DOWNLOADS", "1")
  logs = []
  warnings = []
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")))
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.join(" ")))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(fakeHome, { recursive: true, force: true })
  fakeHome = ""
})

const licensePath = (): string => join(cachePath("engine", VERSION), "LICENSE")
const notices = (): string[] => logs.filter((line) => line.includes("BUSL-1.1"))

describe("engine download keeps its licence", () => {
  it("saves LICENSE beside the engine and says so once", async () => {
    stubRelease({ manifestListsLicense: true, licenseBody: LICENSE })
    await download("engine", VERSION, PLATFORM)

    expect(readFileSync(licensePath(), "utf8")).toBe(LICENSE)
    expect(notices()).toEqual([`[supatype] Supatype engine is licensed under BUSL-1.1; see ${licensePath()}`])
  })

  it("does not repeat the notice when the engine is already cached", async () => {
    stubRelease({ manifestListsLicense: true, licenseBody: LICENSE })
    expect((await download("engine", VERSION, PLATFORM)).fetched).toBe(true)
    logs = []
    // `update` reports from this: a cached engine is not said to be downloaded.
    expect((await download("engine", VERSION, PLATFORM)).fetched).toBe(false)
    expect(notices()).toEqual([])
  })

  it("still installs an older release that published no LICENSE, with one warning", async () => {
    stubRelease({ manifestListsLicense: false, licenseBody: null })
    const { path } = await download("engine", VERSION, PLATFORM)

    expect(existsSync(path)).toBe(true)
    expect(existsSync(licensePath())).toBe(false)
    expect(warnings.filter((line) => line.includes("LICENSE"))).toHaveLength(1)
    expect(notices()).toEqual([])
  })

  it("refuses a LICENSE that does not match the signed checksum, without failing the engine", async () => {
    stubRelease({ manifestListsLicense: true, licenseBody: "something else entirely\n" })
    const { path } = await download("engine", VERSION, PLATFORM)

    expect(existsSync(path)).toBe(true)
    expect(existsSync(licensePath())).toBe(false)
    expect(warnings.filter((line) => line.includes("LICENSE"))).toHaveLength(1)
  })

  it("asks for no licence for the other components", async () => {
    const requested = stubRelease({ manifestListsLicense: true, licenseBody: LICENSE })
    await download("realtime", VERSION, PLATFORM)
    expect(requested.some((url) => url.endsWith("/LICENSE"))).toBe(false)
  })
})
