import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { projectConfig } from "./support/project-config.js"

const sent = vi.hoisted(() => ({ bodies: [] as unknown[], refuse: 0 }))
vi.mock("../src/target-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/target-client.js")>()
  return {
    ...actual,
    targetFetch: async (_base: string, _prefix: string, opts: { body?: unknown }) => {
      sent.bodies.push(opts.body)
      if (sent.refuse !== 0) throw new actual.TargetApiError("Forbidden", sent.refuse)
      return {}
    },
  }
})

const { deployHooksToTarget, uploadHooks } = await import("../src/commands/push.js")

/**
 * The hook deploy body was built differently per target: the maps only for self-host, and nothing at
 * all for a schema with no hooks, so a Cloud project whose schema dropped its last hook kept it. One
 * body now goes to every target, the manifest's three maps in it.
 */
const dirs: string[] = []
afterEach(() => {
  sent.bodies.length = 0
  sent.refuse = 0
  process.exitCode = undefined
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ast = {
  models: [{ name: "Note", fields: {}, annotations: { db: { tableName: "note" }, platform: { cache: { enabled: true } } } }],
}

describe("the hook deploy body", () => {
  for (const mode of ["cloud", "self-host"] as const) {
    it(`is sent to a ${mode} target with the manifest's maps, though the schema declares no hook`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "supatype-hooks-body-"))
      dirs.push(cwd)
      vi.spyOn(console, "log").mockImplementation(() => undefined)
      const target = { mode, environment: "production", projectRef: "demo", apiBaseUrl: "https://stack.example.test", apiPrefix: "/platform/v1", token: "key", link: null } as const
      await deployHooksToTarget(cwd, projectConfig(), target, ast)
      expect(sent.bodies).toEqual([{ handlers: [], map: {}, validators: {}, cache: { note: { enabled: true } } }])
    })
  }
})

describe("an empty hook deploy", () => {
  const target = { mode: "cloud", environment: "production", projectRef: "demo", apiBaseUrl: "https://api.example.test", apiPrefix: "/api/v1", token: "key", link: null } as const
  const said: string[] = []

  function project(): string {
    const cwd = mkdtempSync(join(tmpdir(), "supatype-hooks-body-"))
    dirs.push(cwd)
    said.length = 0
    for (const stream of ["log", "error"] as const) {
      vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
    }
    return cwd
  }

  // Nic's decision (a): a per-machine record of which targets were given hooks missed every target a
  // fresh clone or another machine had deployed to, which kept hooks the schema no longer declares.
  // Every push sends the full body, empty when nothing is declared, so the target holds what the
  // schema says wherever it was pushed from.
  it("is sent from a fresh clone that never deployed, clearing the target's hooks", async () => {
    const cwd = project()
    expect(await deployHooksToTarget(cwd, projectConfig(), target, { models: [] })).toBe(false)
    expect(sent.bodies).toEqual([{ handlers: [], map: {}, validators: {}, cache: {} }])
    expect(said.join("\n")).not.toMatch(/\d+ hook\(s\)/)
  })

  // An empty deploy that clears hooks is a real change, so a refusal of it, 403 included, fails.
  it("fails the push when the target refuses it, 403 included", async () => {
    const cwd = project()
    sent.refuse = 403
    expect(await deployHooksToTarget(cwd, projectConfig(), target, { models: [] })).toBe(true)
    expect(process.exitCode).toBe(1)
  })

  it("still fails a hook deploy refused with 403 when it carries hooks", async () => {
    project()
    sent.refuse = 403
    expect(await uploadHooks(target, { handlers: [{ name: "h", source: "x" }], map: {} }, 1)).toBe(true)
    expect(process.exitCode).toBe(1)
  })
})
