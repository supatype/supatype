import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

let fakeHome = ""

// The cache lives under the home directory; every test here gets its own, never the real one.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => (fakeHome.length > 0 ? fakeHome : actual.homedir()) }
})

import { archiveNameCandidates, currentPlatform, download, fetchLatestVersion, type PlatformId } from "../src/binary-cache.js"

/**
 * realtime-release.yml published the realtime binaries with no checksums.sha256 and no minisign
 * signature, and the CLI refuses any component release without both, so the first realtime release
 * would have put binaries on the CDN that no CLI could install. Published paths are immutable, so
 * that version could never have been repaired. These run each workflow's manifest script and the
 * same minisign signing command on dummy artifacts, then install through the CLI's own download:
 * realtime's binaries, and storage's archives (storage-release.yml), which follow the same contract.
 */
type Released = "realtime" | "storage"
const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const VERSION = "0.7.0"
const PASSWORD = "throwaway"
const PLATFORM: PlatformId = currentPlatform()
const ALL_PLATFORMS: PlatformId[] = [
  { os: "darwin", arch: "amd64" },
  { os: "darwin", arch: "arm64" },
  { os: "linux", arch: "amd64" },
  { os: "linux", arch: "arm64" },
  { os: "windows", arch: "amd64" },
]
const MAGIC: Record<PlatformId["os"], number[]> = {
  linux: [0x7f, 0x45, 0x4c, 0x46],
  windows: [0x4d, 0x5a, 0x90, 0x00],
  darwin: [0xcf, 0xfa, 0xed, 0xfe],
}
/** The first bytes the CLI checks a storage archive for: a zip on Windows, gzip elsewhere. */
const ARCHIVE_MAGIC = (os: PlatformId["os"]): number[] => (os === "windows" ? [0x50, 0x4b, 0x03, 0x04] : [0x1f, 0x8b, 0x08, 0x00])

const hasMinisign = spawnSync("minisign", ["-v"]).status === 0
/**
 * A developer without minisign gets a skip; CI does not. Every CI job that runs this suite
 * installs minisign, so its absence there is a broken runner, and a skip would report the
 * signing checks as passed when none of them ran.
 */
const ciValue = (process.env.CI ?? "").toLowerCase()
const inCI = ciValue !== "" && ciValue !== "false" && ciValue !== "0"

let work = ""
const releaseDir = (): string => join(work, "release")

/** The component the running suite releases; each describe below runs once for each. */
let component: Released = "realtime"
const nameFor = (p: PlatformId): string => archiveNameCandidates(component, VERSION, p)[0]!
const magicFor = (p: PlatformId): number[] => (component === "storage" ? ARCHIVE_MAGIC(p.os) : MAGIC[p.os])
const binaryFor = (p: PlatformId): Buffer => Buffer.concat([Buffer.from(magicFor(p)), Buffer.from(nameFor(p).padEnd(124, "."))])

function writeBinaries(platforms: PlatformId[]): void {
  mkdirSync(releaseDir(), { recursive: true })
  for (const p of platforms) writeFileSync(join(releaseDir(), nameFor(p)), binaryFor(p))
}

/** The workflow's "Generate checksums.sha256 and latest.json" step. */
function runManifestScript(): { status: number | null; stderr: string } {
  const script = join(PACKAGES, component, "scripts", "release-manifest.mjs")
  const r = spawnSync(process.execPath, [script, releaseDir(), VERSION, join(work, "latest.json")], { encoding: "utf8" })
  return { status: r.status, stderr: r.stderr }
}

function minisign(args: string[], input: string, cwd: string): void {
  const r = spawnSync("minisign", args, { cwd, input, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`minisign ${args.join(" ")} failed: ${r.stderr}`)
}

/** Key pairs are generated once per run: minisign derives each from its password with scrypt, which is slow. */
let keys = ""

/** A throwaway key pair, password-protected like the real one. */
function generateKey(name: string): void {
  minisign(["-G", "-f", "-p", `${name}.pub`, "-s", `${name}.key`], `${PASSWORD}\n${PASSWORD}\n`, keys)
}

const publicKey = (name: string): string => readFileSync(join(keys, `${name}.pub`), "utf8")

/** The workflow's "Sign checksums.sha256" step, with the password on stdin as CI passes it. */
function signChecksums(keyName: string): void {
  const args = ["-S", "-s", join(keys, `${keyName}.key`), "-m", "checksums.sha256", "-t", `supatype ${component} releases v${VERSION}`]
  minisign(args, `${PASSWORD}\n`, releaseDir())
}

/** Serve the release directory as releases.supatype.com/<component>/, and latest.json beside it. */
function serveRelease(): void {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input)
    const file = url.endsWith(`/${component}/latest.json`)
      ? join(work, "latest.json")
      : join(releaseDir(), url.slice(url.lastIndexOf("/") + 1))
    if (!url.includes(`/${component}/`) || !existsSync(file)) return new Response("not found", { status: 404 })
    return new Response(readFileSync(file))
  })
}

beforeEach(() => {
  work = join(tmpdir(), `supatype-component-release-${process.pid}-${Date.now()}`)
  fakeHome = join(work, "home")
  mkdirSync(fakeHome, { recursive: true })
  vi.stubEnv("SUPATYPE_ALLOW_UNVERIFIED_DOWNLOADS", "")
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  serveRelease()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(work, { recursive: true, force: true })
  fakeHome = ""
})

describe.each(["realtime", "storage"] as const)("%s release manifest", (released) => {
  beforeEach(() => {
    component = released
  })

  it("covers exactly the binary the CLI asks for on every platform, in sha256sum's format", () => {
    writeBinaries(ALL_PLATFORMS)
    expect(runManifestScript().status).toBe(0)

    const lines = readFileSync(join(releaseDir(), "checksums.sha256"), "utf8").trimEnd().split("\n")
    const expected = ALL_PLATFORMS.map((p) => `${createHash("sha256").update(binaryFor(p)).digest("hex")}  ${nameFor(p)}`)
    expect(lines.sort()).toEqual(expected.sort())
  })

  it("writes latest.json in the shape every other component publishes, readable by the CLI", async () => {
    writeBinaries(ALL_PLATFORMS)
    expect(runManifestScript().status).toBe(0)

    const latest: unknown = JSON.parse(readFileSync(join(work, "latest.json"), "utf8"))
    expect(latest).toEqual({
      version: VERSION,
      date: new Date().toISOString().slice(0, 10),
      checksums_url: `https://releases.supatype.com/${component}/v${VERSION}/checksums.sha256`,
    })
    await expect(fetchLatestVersion(component)).resolves.toBe(VERSION)
  })

  it("refuses to write a manifest when a platform's binary is missing", () => {
    writeBinaries(ALL_PLATFORMS.filter((p) => p.os !== "windows"))
    const result = runManifestScript()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(nameFor({ os: "windows", arch: "amd64" }))
    expect(existsSync(join(releaseDir(), "checksums.sha256"))).toBe(false)
  })
})

// Registered only when it fails, so a run with minisign shows no extra skipped test.
if (inCI && !hasMinisign) {
  it("has minisign on PATH in CI, so the signing tests below run instead of skipping", () => {
    throw new Error(
      "minisign is not on PATH, and CI is set. ci.yml and release.yml install it for this suite; " +
        "without it the signing tests skip and the release manifest's signature goes untested.",
    )
  })
}

describe.skipIf(!hasMinisign).each(["realtime", "storage"] as const)("installing a %s release through the CLI", (released) => {
  beforeEach(() => {
    component = released
  })

  beforeAll(() => {
    keys = join(tmpdir(), `supatype-${released}-release-keys-${process.pid}-${Date.now()}`)
    mkdirSync(keys, { recursive: true })
    generateKey("release")
    generateKey("intruder")
  })

  afterAll(() => rmSync(keys, { recursive: true, force: true }))

  it("refuses a release published as the old workflow did: binaries, no checksums", async () => {
    writeBinaries(ALL_PLATFORMS)
    vi.stubEnv("SUPATYPE_RELEASE_PUBLIC_KEY", publicKey("release"))
    await expect(download(component, VERSION, PLATFORM)).rejects.toThrow(/Failed to fetch checksums/)
  })

  it("refuses checksums that were never signed", async () => {
    writeBinaries(ALL_PLATFORMS)
    expect(runManifestScript().status).toBe(0)
    vi.stubEnv("SUPATYPE_RELEASE_PUBLIC_KEY", publicKey("release"))
    await expect(download(component, VERSION, PLATFORM)).rejects.toThrow(/checksum signature/)
  })

  it("refuses checksums signed by a key other than the release key", async () => {
    writeBinaries(ALL_PLATFORMS)
    expect(runManifestScript().status).toBe(0)
    signChecksums("intruder")
    vi.stubEnv("SUPATYPE_RELEASE_PUBLIC_KEY", publicKey("release"))
    await expect(download(component, VERSION, PLATFORM)).rejects.toThrow(/key ID mismatch/)
  })

  it("installs the binary when the manifest is generated and signed as the workflow does", async () => {
    writeBinaries(ALL_PLATFORMS)
    expect(runManifestScript().status).toBe(0)
    vi.stubEnv("SUPATYPE_RELEASE_PUBLIC_KEY", publicKey("release"))
    signChecksums("release")

    const { path: installed } = await download(component, VERSION, PLATFORM)
    expect(readFileSync(installed)).toEqual(binaryFor(PLATFORM))
  })
})
