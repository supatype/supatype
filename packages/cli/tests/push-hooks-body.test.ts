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

  function project(): string {
    const cwd = mkdtempSync(join(tmpdir(), "supatype-hooks-body-"))
    dirs.push(cwd)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    return cwd
  }

  // Review: Cloud got a hook deploy on every push, so a member who may push a schema but not deploy
  // hooks failed every push, under "Deploying 0 hook(s)".
  it("is not sent when nothing is declared and nothing was deployed to that target", async () => {
    const cwd = project()
    expect(await deployHooksToTarget(cwd, projectConfig(), target, { models: [] })).toBe(false)
    expect(sent.bodies).toEqual([])
  })

  // Review: an empty deploy that clears hooks deployed before is a real change, so a 403 for it fails.
  it("is sent to clear what the target was last given, and fails when the target refuses it", async () => {
    const cwd = project()
    const hooked = { models: [{ name: "Note", fields: {}, annotations: { db: { tableName: "note" }, platform: { cache: { enabled: true } } } }] }
    expect(await deployHooksToTarget(cwd, projectConfig(), target, hooked)).toBe(false)
    sent.bodies.length = 0
    sent.refuse = 403
    expect(await deployHooksToTarget(cwd, projectConfig(), target, { models: [] })).toBe(true)
    expect(sent.bodies).toEqual([{ handlers: [], map: {}, validators: {}, cache: {} }])
    expect(process.exitCode).toBe(1)
  })

  it("still fails a hook deploy refused with 403 when it carries hooks", async () => {
    project()
    sent.refuse = 403
    expect(await uploadHooks(target, { handlers: [{ name: "h", source: "x" }], map: {} }, 1)).toBe(true)
    expect(process.exitCode).toBe(1)
  })
})
