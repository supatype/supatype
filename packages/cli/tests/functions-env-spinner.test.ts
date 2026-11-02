import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"

/**
 * Round 7: `functions env set/unset/list` take 2.6 to 3.4 s on a self-hosted stack with nothing on
 * screen. Nic accepts the time as long as something shows it is working: one spinner from the start
 * of the command (the config and link read) to the target's answer, for every target.
 */
const spun = vi.hoisted(() => ({ active: false, messages: [] as string[], loadsInside: 0, loadsOutside: 0 }))
vi.mock("../src/ui/progress.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withSpinner: async <T,>(message: string, task: () => Promise<T>): Promise<T> => {
    spun.messages.push(message)
    spun.active = true
    try {
      return await task()
    } finally {
      spun.active = false
    }
  },
}))
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>()
  return {
    ...actual,
    loadConfig: (cwd?: string) => {
      if (spun.active) spun.loadsInside++
      else spun.loadsOutside++
      return actual.loadConfig(cwd)
    },
  }
})

const { registerFunctions } = await import("../src/commands/functions.js")

let project: { dir: string; remove: () => void }
let fetchedInside: boolean[] = []

beforeEach(() => {
  project = tempProject("functions-env-spinner")
  writeFileSync(
    join(project.dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`,
  )
  mkdirSync(join(project.dir, ".supatype"), { recursive: true })
  writeFileSync(join(project.dir, ".supatype", "link.json"), JSON.stringify({
    version: 1,
    kind: "self-host",
    projectRef: "acme",
    defaultEnvironment: "production",
    environments: { production: { name: "production", apiUrl: "https://sh.example.test", token: "svc-key", linkedAt: "2026-01-01T00:00:00Z" } },
  }))
  spun.messages = []
  spun.loadsInside = 0
  spun.loadsOutside = 0
  fetchedInside = []
  vi.stubGlobal("fetch", () => {
    fetchedInside.push(spun.active)
    return Promise.resolve(new Response(JSON.stringify({ data: { key: "K", removed: true } }), { headers: { "Content-Type": "application/json" } }))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  project.remove()
})

describe("functions env commands on a linked target", () => {
  for (const [argv, said] of [
    [["functions", "env", "set", "K=v"], "Set K"],
    [["functions", "env", "unset", "K"], "Removed K"],
    [["functions", "env", "list"], "values masked"],
  ] as const) {
    it(`show a spinner from the start to the answer: ${argv.slice(1).join(" ")}`, async () => {
      const run = await runCommand(registerFunctions, [...argv], project.dir)
      expect(spun.messages).toHaveLength(1)
      expect(fetchedInside).toEqual([true])
      expect(spun.loadsInside).toBeGreaterThan(0)
      expect(spun.loadsOutside).toBe(0)
      expect(run.output).toContain(said)
    }, 20_000)
  }
})

describe("functions env set on a project that is not linked", () => {
  it("shows the spinner too", async () => {
    rmSync(join(project.dir, ".supatype", "link.json"))
    mkdirSync(join(project.dir, "functions"), { recursive: true })
    const run = await runCommand(registerFunctions, ["functions", "env", "set", "K=v"], project.dir)
    expect(spun.messages).toHaveLength(1)
    expect(run.output).toContain("Set K in local env file.")
  }, 20_000)
})
