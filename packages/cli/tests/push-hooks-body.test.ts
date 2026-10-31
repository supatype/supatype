import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { projectConfig } from "./support/project-config.js"

const sent = vi.hoisted(() => ({ bodies: [] as unknown[] }))
vi.mock("../src/target-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/target-client.js")>()),
  targetFetch: async (_base: string, _prefix: string, opts: { body?: unknown }) => {
    sent.bodies.push(opts.body)
    return {}
  },
}))

const { deployHooksToTarget } = await import("../src/commands/push.js")

/**
 * The hook deploy body was built differently per target: the maps only for self-host, and nothing at
 * all for a schema with no hooks, so a Cloud project whose schema dropped its last hook kept it. One
 * body now goes to every target, the manifest's three maps in it.
 */
const dirs: string[] = []
afterEach(() => {
  sent.bodies.length = 0
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
