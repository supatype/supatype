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
const project = vi.hoisted(() => ({ versions: undefined as Record<string, string> | undefined, latest: {} }))

vi.mock("../src/binary-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/binary-cache.js")>()),
  currentPlatform: () => ({ os: "linux", arch: "amd64" }),
  fetchAllLatestVersions: vi.fn(async () => project.latest),
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
})
