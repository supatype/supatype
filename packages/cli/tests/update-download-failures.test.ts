import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * Local test I: every download failed, each printed "Failed: ...", and `update` then said "All
 * components are up to date." and exited 0. A script, or a person reading the last line, took a
 * machine with nothing installed for an up-to-date one.
 */

const messages = vi.hoisted(() => ({ info: [] as string[], error: [] as string[] }))
const project = vi.hoisted(() => ({
  versions: undefined as Record<string, string> | undefined,
  latest: {},
  cached: new Set<string>(),
}))

vi.mock("../src/binary-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/binary-cache.js")>()),
  currentPlatform: () => ({ os: "linux", arch: "amd64" }),
  fetchAllLatestVersions: vi.fn(async () => project.latest),
  isCachedBinaryReady: (component: string) => project.cached.has(component),
  download: vi.fn(async () => {
    throw new Error("CDN answered 404")
  }),
}))

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: (): SupatypeProjectConfig => ({
    project: { name: "demo" },
    database: { provider: "native" },
    server: { mode: "dev" },
    app: { mode: "none" },
    ...(project.versions !== undefined && { versions: project.versions }),
  }),
}))

vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  info: (message: string) => messages.info.push(message),
  error: (message: string) => messages.error.push(message),
  plain: () => undefined,
}))

vi.mock("../src/ui/fatal.js", () => ({
  fatalError: (message: string, hints: string[] = []): never => {
    throw new Error([message, ...hints].join("\n"))
  },
}))

const { registerUpdate } = await import("../src/commands/update.js")
const { download } = await import("../src/binary-cache.js")

async function runUpdate(): Promise<void> {
  const program = new Command().exitOverride()
  registerUpdate(program)
  await program.parseAsync(["node", "supatype", "update"])
}

beforeEach(() => {
  messages.info.length = 0
  messages.error.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  project.versions = undefined
  project.latest = {}
  project.cached.clear()
})

describe("supatype update when downloads fail", () => {
  it("exits non-zero naming each component that failed, and never says up to date", async () => {
    await expect(runUpdate()).rejects.toThrow(/could not be updated[\s\S]*engine: CDN answered 404/)
    expect(messages.info).not.toContain("All components are up to date.")
  })

  it("leaves a pinned version alone when its new version could not be downloaded", async () => {
    // It wrote the new version into the config whether or not the download worked, so the next
    // run asked for a binary that was never installed.
    const cwd = mkdtempSync(join(tmpdir(), "supatype-update-"))
    const configText = ["export default {", "  versions: {", '    engine: "0.1.0",', "  },", "}", ""].join("\n")
    try {
      writeFileSync(join(cwd, "supatype.config.ts"), configText, "utf8")
      vi.spyOn(process, "cwd").mockReturnValue(cwd)
      project.versions = { engine: "0.1.0" }
      project.latest = { engine: "0.2.0" }
      await expect(runUpdate()).rejects.toThrow(/engine: CDN answered 404/)
      expect(readFileSync(join(cwd, "supatype.config.ts"), "utf8")).toBe(configText)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/** Every native component pinned to 1.0.0 with the CDN naming the same, then `changes` applied. */
function pinAll(changes: { versions: Record<string, string>; latest: Record<string, string | undefined> }): void {
  const base = { engine: "1.0.0", server: "1.0.0", postgres: "1.0.0", deno: "1.0.0", realtime: "1.0.0" }
  project.versions = { ...base, ...changes.versions }
  project.latest = Object.fromEntries(
    Object.entries({ ...base, ...changes.latest }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

/** The component each line of the failure report names, in the order it names them. */
async function reportedFailures(): Promise<string[]> {
  const failure = await runUpdate().then(
    () => new Error("update succeeded"),
    (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  )
  return failure.message.split("\n").flatMap((line) => /^(\w+): /.exec(line)?.slice(1) ?? [])
}

describe("supatype update plans", () => {
  it("skips a component pinned to local, even when the CDN names no latest for it", async () => {
    // The missing latest was checked first, so a local engine build became a failure and exit 1.
    pinAll({ versions: { engine: "local" }, latest: { engine: undefined } })
    await expect(runUpdate()).resolves.toBeUndefined()
    expect(messages.error).toEqual([])
  })

  it("reports failures in component order, whichever step found them", async () => {
    // The engine's new version fails to download; the server has no latest on the CDN. The
    // download failures were appended after the plan's, so the server came first.
    pinAll({ versions: { engine: "0.1.0" }, latest: { engine: "0.2.0", server: undefined } })
    expect(await reportedFailures()).toEqual(["engine", "server"])
  })
})

describe("supatype update downloads", () => {
  it("fetches every component at once and reports them in a fixed order however they finish", async () => {
    // One at a time, a slow CDN cost the sum of every download. Started together, they finish in any
    // order, and the report still has to read the same on every run.
    const events: string[] = []
    const finishLast = ["engine", "server", "postgres", "deno", "realtime"]
    vi.mocked(download).mockImplementation(async (component) => {
      events.push(`start ${component}`)
      await new Promise((resolve) => setTimeout(resolve, 10 * (finishLast.length - finishLast.indexOf(component))))
      events.push(`end ${component}`)
      throw new Error(`${component} answered 404`)
    })
    try {
      await expect(runUpdate()).rejects.toThrow(/could not be updated/)
    } finally {
      vi.mocked(download).mockImplementation(async () => {
        throw new Error("CDN answered 404")
      })
    }
    const started = events.filter((event) => event.startsWith("start ")).map((event) => event.slice("start ".length))
    expect(started.length).toBeGreaterThan(1)
    // Every download began before the first one ended.
    expect(events.slice(0, started.length).every((event) => event.startsWith("start "))).toBe(true)
    // The last to finish is reported first, as it is the first fetched.
    const ended = events.filter((event) => event.startsWith("end ")).map((event) => event.slice("end ".length))
    expect(ended).not.toEqual(started)
    const reported = messages.error.flatMap((message) => /^Failed: (\w+) /.exec(message)?.slice(1) ?? [])
    expect(reported).toEqual(started)
  })

  // Local test: "postgres v17.2.10 already cached." was followed by "postgres v17.2.10 downloaded."
  it("does not call a component it already had downloaded", async () => {
    project.cached.add("postgres")
    vi.mocked(download).mockImplementation(async () => "/cache/binary")
    try {
      // Components this CLI does not pin and the CDN names nothing for still fail; not the point here.
      await runUpdate().catch(() => undefined)
    } finally {
      vi.mocked(download).mockImplementation(async () => {
        throw new Error("CDN answered 404")
      })
    }
    const said = messages.info.filter((message) => message.startsWith("postgres "))
    expect(said).toEqual([expect.stringMatching(/^postgres v\S+ already cached\.$/)])
    expect(vi.mocked(download).mock.calls.map(([component]) => component)).not.toContain("postgres")
  })
})

/** The advice lines of the failure report: every line after the per-component ones. */
async function reportedAdvice(): Promise<string> {
  const failure = await runUpdate().then(
    () => new Error("update succeeded"),
    (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  )
  return failure.message
    .split("\n")
    .filter((line) => !/^\w+: /.test(line))
    .join("\n")
}

describe("the advice for each failure", () => {
  // Local test: with no release key, update said "Run `supatype update` again once the CDN is
  // reachable". The CDN was reachable; the key was what was missing.
  it("names the release key, not the CDN, when the key is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "supatype-update-home-"))
    vi.stubEnv("HOME", home)
    vi.stubEnv("USERPROFILE", home)
    vi.stubEnv("SUPATYPE_RELEASE_PUBLIC_KEY", "")
    vi.stubEnv("SUPATYPE_ALLOW_UNVERIFIED_DOWNLOADS", "")
    vi.stubGlobal("fetch", async () => new Response("0000  supatype-realtime-linux-amd64\n"))
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const actual = await vi.importActual<typeof import("../src/binary-cache.js")>("../src/binary-cache.js")
    vi.mocked(download).mockImplementation(actual.download)
    try {
      pinAll({ versions: { realtime: "0.6.0" }, latest: { realtime: "0.7.0" } })
      const advice = await reportedAdvice()
      expect(advice).not.toMatch(/CDN is reachable/)
      expect(advice).toMatch(/SUPATYPE_RELEASE_PUBLIC_KEY/)
    } finally {
      vi.mocked(download).mockImplementation(async () => {
        throw new Error("CDN answered 404")
      })
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
      rmSync(home, { recursive: true, force: true })
    }
  }, 20_000)

  it("does not blame the network for a version the CDN never published", async () => {
    pinAll({ versions: {}, latest: { server: undefined } })
    const advice = await reportedAdvice()
    expect(advice).not.toMatch(/CDN is reachable/)
    expect(advice).toMatch(/Pin server under versions/)
  })
})
