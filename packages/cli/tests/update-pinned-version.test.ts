import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * Release test 0.9.2 round 3, FF-3 and FF-4: a native project pinned to a Postgres version was
 * trapped. `dev` said "Postgres 17.2.12 archive not found. Run: supatype update", and `update` said
 * "All components are up to date." without fetching it, because the pin matched the CDN's latest.
 * Pinned to an older version instead, `update` downloaded the new one and wrote it into the
 * commented example line `init` puts above the versions block, leaving the real pin as it was.
 */

const messages = vi.hoisted(() => ({ info: [] as string[], error: [] as string[], plain: [] as string[] }))
const project = vi.hoisted(() => ({
  versions: undefined as Record<string, string> | undefined,
  latest: {} as Record<string, string>,
  cached: new Set<string>(),
}))

vi.mock("../src/binary-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/binary-cache.js")>()),
  currentPlatform: () => ({ os: "linux", arch: "amd64" }),
  fetchAllLatestVersions: vi.fn(async () => project.latest),
  isCachedBinaryReady: vi.fn((component: string, version: string) => project.cached.has(`${component}@${version}`)),
  download: vi.fn(async (component: string, version: string) => ({
    path: `/cache/${component}/${version}`,
    fetched: !project.cached.has(`${component}@${version}`),
  })),
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
  plain: (message: string) => messages.plain.push(message),
}))

// What a release build has built in, held out, as in update-download-failures.test.ts.
vi.mock("../src/release-public-key.js", () => ({ releasePublicKey: () => "" }))
vi.mock("../src/cli-version-embedded.js", () => ({ EMBEDDED_CLI_VERSION: "" }))

vi.mock("../src/ui/fatal.js", () => ({
  fatalError: (message: string, hints: string[] = []): never => {
    throw new Error([message, ...hints].join("\n"))
  },
}))

const { registerUpdate } = await import("../src/commands/update.js")
const { download } = await import("../src/binary-cache.js")
const { defaultScaffoldOptions, scaffold } = await import("../src/commands/init.js")

async function runUpdate(...args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  registerUpdate(program)
  await program.parseAsync(["node", "supatype", "update", ...args])
}

/** Every native component pinned and cached at the CDN's latest, then `versions` pinned over it. */
function pinned(versions: Record<string, string>, latest: Record<string, string | undefined>): void {
  const base = { engine: "1.0.0", server: "1.0.0", postgres: "1.0.0", deno: "1.0.0", realtime: "1.0.0", storage: "1.0.0" }
  project.versions = { ...base, ...versions }
  project.latest = Object.fromEntries(
    Object.entries({ ...base, ...latest }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  for (const [component, version] of Object.entries(base)) project.cached.add(`${component}@${version}`)
}

let cwd = ""

beforeEach(() => {
  messages.info.length = 0
  messages.error.length = 0
  messages.plain.length = 0
  cwd = mkdtempSync(join(tmpdir(), "supatype-update-pin-"))
  vi.spyOn(process, "cwd").mockReturnValue(cwd)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  project.versions = undefined
  project.latest = {}
  project.cached.clear()
  rmSync(cwd, { recursive: true, force: true })
})

describe("FF-3: a pinned version that is not on this machine", () => {
  it("is downloaded when it is the CDN's latest", async () => {
    pinned({ postgres: "17.2.12" }, { postgres: "17.2.12" })
    await runUpdate()
    expect(vi.mocked(download)).toHaveBeenCalledWith("postgres", "17.2.12", { os: "linux", arch: "amd64" })
    expect(messages.info).toContain("postgres v17.2.12 downloaded.")
    // Round 4: it then said "All components are up to date." right after downloading one.
    expect(messages.info).not.toContain("All components are up to date.")
  })

  it("is not downloaded again when it is already cached", async () => {
    pinned({ postgres: "17.2.12" }, { postgres: "17.2.12" })
    project.cached.add("postgres@17.2.12")
    await runUpdate()
    expect(messages.info.filter((message) => message.startsWith("postgres "))).toEqual([])
    expect(messages.info).toContain("All components are up to date.")
  })

  it("is reported as missing by --check, which downloads nothing", async () => {
    pinned({ postgres: "17.2.12" }, { postgres: "17.2.12" })
    await runUpdate("--check")
    expect(vi.mocked(download)).not.toHaveBeenCalled()
    expect(messages.plain).toContain("  postgres  17.2.12 is pinned but not downloaded. `supatype update` fetches it.")
    expect(messages.info).not.toContain("All pinned components match CDN latest.")
  })
})

/** Run `update` with the download of `component@version` failing at the CDN. The failure report. */
async function updateFailingFor(failing: string): Promise<string> {
  const served = vi.mocked(download).getMockImplementation()
  vi.mocked(download).mockImplementation(async (component, version, platform) => {
    if (`${component}@${version}` === failing) throw new Error("CDN answered 404")
    if (served === undefined) throw new Error("download has no mock")
    return served(component, version, platform)
  })
  try {
    return await runUpdate().then(
      () => "update succeeded",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
  } finally {
    if (served !== undefined) vi.mocked(download).mockImplementation(served)
  }
}

describe("a pinned version the CDN names no latest for", () => {
  it("is downloaded, not reported as a failure", async () => {
    pinned({ postgres: "17.2.12" }, { postgres: undefined })
    await runUpdate()
    expect(vi.mocked(download)).toHaveBeenCalledWith("postgres", "17.2.12", { os: "linux", arch: "amd64" })
    expect(messages.error).toEqual([])
  })

  it("is downloaded for realtime too, which used to be skipped", async () => {
    pinned({ realtime: "0.9.2" }, { realtime: undefined })
    await runUpdate()
    expect(vi.mocked(download)).toHaveBeenCalledWith("realtime", "0.9.2", { os: "linux", arch: "amd64" })
  })

  it("is reported as missing by --check", async () => {
    pinned({ postgres: "17.2.12" }, { postgres: undefined })
    await runUpdate("--check")
    expect(vi.mocked(download)).not.toHaveBeenCalled()
    expect(messages.plain).toContain("  postgres  17.2.12 is pinned but not downloaded. `supatype update` fetches it.")
  })
})

describe("a pin newer than the CDN's latest", () => {
  it("is kept and downloaded, not swapped for the older version", async () => {
    writeFileSync(join(cwd, "supatype.config.ts"), 'export default { versions: { postgres: "17.2.13" } }\n', "utf8")
    pinned({ postgres: "17.2.13" }, { postgres: "17.2.12" })
    await runUpdate()
    expect(vi.mocked(download)).toHaveBeenCalledWith("postgres", "17.2.13", { os: "linux", arch: "amd64" })
    expect(vi.mocked(download)).not.toHaveBeenCalledWith("postgres", "17.2.12", expect.anything())
    expect(readFileSync(join(cwd, "supatype.config.ts"), "utf8")).toContain('postgres: "17.2.13"')
  })

  it("is said to be ahead of the CDN by --check", async () => {
    pinned({ postgres: "17.2.13" }, { postgres: "17.2.12" })
    project.cached.add("postgres@17.2.13")
    await runUpdate("--check")
    expect(messages.plain).toContain("  postgres  17.2.13 is pinned, ahead of 17.2.12 on the CDN")
    expect(messages.info).not.toContain("All pinned components match CDN latest.")
  })

  it("fails loudly when it was never published, instead of being replaced", async () => {
    pinned({ postgres: "17.2.99" }, { postgres: "17.2.12" })
    expect(await updateFailingFor("postgres@17.2.99")).toMatch(/could not be updated[\s\S]*postgres: CDN answered 404/)
  })

  it("is moved to the CDN's latest as before when it is not plain numbers", async () => {
    pinned({ postgres: "17.2.13-rc.1" }, { postgres: "17.2.12" })
    await updateFailingFor("postgres@17.2.12")
    expect(vi.mocked(download)).toHaveBeenCalledWith("postgres", "17.2.12", { os: "linux", arch: "amd64" })
  })
})

/** The config `supatype init` writes for a native project, as it writes it today. */
function initConfig(): string {
  const dir = join(cwd, "scaffold")
  scaffold(dir, { ...defaultScaffoldOptions("demo"), provider: "native" })
  return readFileSync(join(dir, "supatype.config.ts"), "utf8")
}

/** `text` with `block` added on the line after init's commented example `versions` line. */
function withRealPin(text: string, block: string): string {
  const lines = text.split("\n")
  const example = lines.findIndex((line) => line.trimStart().startsWith("// versions:"))
  expect(example).toBeGreaterThan(-1)
  lines.splice(example + 1, 0, block)
  return lines.join("\n")
}

async function updatePostgres(configText: string): Promise<string> {
  writeFileSync(join(cwd, "supatype.config.ts"), configText, "utf8")
  pinned({ postgres: "17.2.11" }, { postgres: "17.2.12" })
  await runUpdate().catch((err: unknown) => {
    messages.error.push(err instanceof Error ? err.message : String(err))
  })
  return readFileSync(join(cwd, "supatype.config.ts"), "utf8")
}

describe("FF-4: writing the new pin into the config", () => {
  it("changes the real one-line versions block and leaves init's comment alone", async () => {
    const before = withRealPin(initConfig(), '  versions: { postgres: "17.2.11", server: "local" },')
    const after = await updatePostgres(before)
    expect(after).toBe(before.replace('versions: { postgres: "17.2.11"', 'versions: { postgres: "17.2.12"'))
    expect(after).toContain('  // versions: { engine: "0.1.2", server: "1.0.5", postgres: "17.2", deno: "2.2.0" },')
    expect(messages.info).toContain("supatype.config.ts updated.")
  })

  it("changes a pin on its own line inside the versions block", async () => {
    const before = withRealPin(initConfig(), ["  versions: {", '    postgres: "17.2.11",', '    server: "local",', "  },"].join("\n"))
    const after = await updatePostgres(before)
    expect(after).toBe(before.replace('    postgres: "17.2.11",', '    postgres: "17.2.12",'))
    expect(messages.info).toContain("supatype.config.ts updated.")
  })

  it("leaves the file alone and says so when the pin is not in it", async () => {
    // The pin came from somewhere the file does not show, here supatype.local.config.ts.
    const before = initConfig()
    const after = await updatePostgres(before)
    expect(after).toBe(before)
    expect(messages.info).not.toContain("supatype.config.ts updated.")
    expect(messages.error.join("\n")).toMatch(/versions\.postgres/)
  })
})

/**
 * Release test 0.9.2 round 4: with the pin in supatype.local.config.ts, `update` wrote the new
 * version over a pin in supatype.config.ts that was not the one in force, or found it already there,
 * and said "supatype.config.ts updated." either way. `dev` then still ran the local file's pin and
 * said its archive was missing, the loop FF-3 and FF-4 were about.
 */
describe("a pin set in supatype.local.config.ts", () => {
  const LOCAL = 'export default { versions: { postgres: "17.2.11" } }\n'

  /** `update` with `main` as supatype.config.ts and `local` laid over it. Both files after. */
  async function updateWithLocalPin(main: string, local: string = LOCAL): Promise<{ main: string; local: string }> {
    writeFileSync(join(cwd, "supatype.local.config.ts"), local, "utf8")
    const after = await updatePostgres(main)
    return { main: after, local: readFileSync(join(cwd, "supatype.local.config.ts"), "utf8") }
  }

  it("leaves a main pin already at the new version alone and does not say updated", async () => {
    const before = 'export default { versions: { postgres: "17.2.12" } }\n'
    expect(await updateWithLocalPin(before)).toEqual({ main: before, local: LOCAL })
    expect(messages.info).not.toContain("supatype.config.ts updated.")
    expect(messages.error.join("\n")).toMatch(/supatype\.local\.config\.ts pins it, and update does not edit that file/)
  })

  it("leaves a main pin at the same version alone, which is not the one in force", async () => {
    const before = 'export default { versions: { postgres: "17.2.11" } }\n'
    expect(await updateWithLocalPin(before)).toEqual({ main: before, local: LOCAL })
    expect(messages.info).not.toContain("supatype.config.ts updated.")
  })

  it("names the local file when the main config pins nothing", async () => {
    const before = "export default { project: { name: \"demo\" } }\n"
    expect(await updateWithLocalPin(before)).toEqual({ main: before, local: LOCAL })
    expect(messages.error.join("\n")).toMatch(/supatype\.local\.config\.ts pins it/)
  })

  // Round 5: `export default local` read as no config, so its pin as none, and update rewrote the
  // main file's pin, said "updated", and dev went on asking for the local file's version.
  it.each([
    ["a const", 'const local = { versions: { postgres: "17.2.11" } }\nexport default local\n'],
    ["a const with satisfies", 'const local = { versions: { postgres: "17.2.11" } } satisfies object\nexport default local\n'],
    ["a const passed to defineConfig", 'const local = { versions: { postgres: "17.2.11" } }\nexport default defineConfig(local)\n'],
  ])("is found when the local file exports %s", async (_form, local) => {
    const before = 'export default { versions: { postgres: "17.2.11" } }\n'
    expect(await updateWithLocalPin(before, local)).toEqual({ main: before, local })
    expect(messages.info).not.toContain("supatype.config.ts updated.")
    expect(messages.error.join("\n")).toMatch(/supatype\.local\.config\.ts pins it, and update does not edit that file/)
  })

  it("is not taken for none when update cannot read the local file's exported config", async () => {
    const local = "export default makeLocalConfig()\n"
    const before = 'export default { versions: { postgres: "17.2.11" } }\n'
    expect(await updateWithLocalPin(before, local)).toEqual({ main: before, local })
    expect(messages.info).not.toContain("supatype.config.ts updated.")
    expect(messages.error.join("\n")).toMatch(/supatype\.local\.config\.ts exports, so cannot tell whether it pins it/)
  })
})

describe("a main pin already at the new version, with no local override", () => {
  it("is left alone, not said to be updated, and not a failure", async () => {
    const before = 'export default { versions: { postgres: "17.2.12" } }\n'
    expect(await updatePostgres(before)).toBe(before)
    expect(messages.info).not.toContain("supatype.config.ts updated.")
    expect(messages.info).toContain("supatype.config.ts already pins postgres 17.2.12.")
    expect(messages.error).toEqual([])
  })
})

describe("a pin supatype.config.ts builds in code", () => {

  it("says a pin built in code is built in code, and not that it was downloaded", async () => {
    project.cached.add("postgres@17.2.12")
    const before = 'const PG_PIN = "17.2.11"\nexport default { versions: { postgres: PG_PIN } }\n'
    const after = await updatePostgres(before)
    expect(after).toBe(before)
    const report = messages.error.join("\n")
    expect(report).toMatch(/versions\.postgres in supatype\.config\.ts is built in code/)
    expect(report).not.toMatch(/downloaded|outside a comment/)
  })
})

describe("withPinnedVersion", () => {
  it("skips a block comment and reads past a URL string that holds //", async () => {
    const { withPinnedVersion } = await import("../src/config-version-pin.js")
    const text = [
      "export default {",
      '  app: { upstream: "http://localhost:3000" },',
      '  /* versions: { postgres: "17.2.0" } */',
      '  versions: { "postgres": \'17.2.11\' },',
      "}",
    ].join("\n")
    const edit = withPinnedVersion(text, "postgres", "17.2.12")
    expect(edit).toEqual({ kind: "edited", text: text.replace("'17.2.11'", "'17.2.12'") })
  })

  it("answers missing for a key the real block does not hold", async () => {
    const { withPinnedVersion } = await import("../src/config-version-pin.js")
    const text = 'export default { versions: { server: "1.0.0" } }'
    expect(withPinnedVersion(text, "postgres", "17.2.12")).toEqual({ kind: "missing" })
  })

  it("changes the pin of a config exported through a const", async () => {
    const { withPinnedVersion } = await import("../src/config-version-pin.js")
    const text = 'const config = { versions: { postgres: "17.2.11" } }\nexport default config\n'
    expect(withPinnedVersion(text, "postgres", "17.2.12")).toEqual({ kind: "edited", text: text.replace("17.2.11", "17.2.12") })
  })

  it("answers current for a pin already at the version", async () => {
    const { withPinnedVersion } = await import("../src/config-version-pin.js")
    expect(withPinnedVersion('export default { versions: { postgres: "17.2.12" } }', "postgres", "17.2.12")).toEqual({ kind: "current" })
  })
})
