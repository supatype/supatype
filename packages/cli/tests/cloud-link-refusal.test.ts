import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `supatype migrate` and `supatype cache rest ...` work on this machine's own database and stack.
 * In a folder linked to a Supatype Cloud project they used to go on to the local stack and say it
 * was not running, as if the link were not there. They now refuse, naming the link.
 */
const said = vi.hoisted(() => ({ errors: [] as string[] }))
const reached = vi.hoisted(() => ({ rest: 0 }))

vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  error: (m: string) => said.errors.push(m),
}))
vi.mock("../src/rest-cache-admin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/rest-cache-admin.js")>()),
  listRestCacheEntries: async () => {
    reached.rest += 1
    return { entries: [], cursor: "0" }
  },
}))

import { registerCache } from "../src/commands/cache.js"
import { registerMigrate } from "../src/commands/migrate.js"
import { LINK_VERSION, saveProjectLink, type ProjectLink } from "../src/link.js"

let dir: string

function link(kind: ProjectLink["kind"]): ProjectLink {
  const stamp = "2026-11-20T00:00:00Z"
  return {
    version: LINK_VERSION,
    kind,
    projectRef: "abc",
    defaultEnvironment: "production",
    token: "tok",
    ...(kind === "cloud" ? { cloudApiUrl: "https://cloud.test" } : {}),
    environments: { production: { name: "production", apiUrl: "https://cloud.test", linkedAt: stamp } },
  }
}

async function run(register: (program: Command) => void, args: string[]): Promise<string> {
  const program = new Command().exitOverride()
  register(program)
  try {
    await program.parseAsync(["node", "supatype", ...args])
    return ""
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-cloud-refusal-"))
  mkdirSync(join(dir, ".supatype"), { recursive: true })
  vi.spyOn(process, "cwd").mockReturnValue(dir)
  said.errors.length = 0
  reached.rest = 0
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe("in a folder linked to Supatype Cloud", () => {
  beforeEach(() => saveProjectLink(dir, link("cloud")))

  it("migrate refuses, naming the link and the project", async () => {
    const message = await run(registerMigrate, ["migrate"])
    expect(message).toContain("supatype migrate")
    expect(message).toContain("Supatype Cloud project")
    expect(message).toContain("abc")
    expect(message).toContain("https://cloud.test")
  })

  it("migrate with --connection still goes to that database", async () => {
    const message = await run(registerMigrate, ["migrate", "--connection", "postgresql://u:p@127.0.0.1:1/x"])
    expect(message).not.toContain("Supatype Cloud project")
  })

  for (const sub of [["list"], ["get", "k"], ["delete", "k"], ["flush", "--yes"]]) {
    it(`cache rest ${sub[0]} refuses, naming the link`, async () => {
      await run(registerCache, ["cache", "rest", ...sub])
      expect(said.errors.join("\n")).toContain(`supatype cache rest ${sub[0]}`)
      expect(said.errors.join("\n")).toContain("Supatype Cloud project")
      expect(said.errors.join("\n")).toContain("abc")
      expect(reached.rest).toBe(0)
      expect(process.exitCode).toBe(1)
    })
  }
})

describe("in a folder with no Cloud link", () => {
  it("cache rest list is not refused for a self-host link", async () => {
    saveProjectLink(dir, link("self-host"))
    await run(registerCache, ["cache", "rest", "list"])
    expect(said.errors.join("\n")).not.toContain("Supatype Cloud project")
  })
})
