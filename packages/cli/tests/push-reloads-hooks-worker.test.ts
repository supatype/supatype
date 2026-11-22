import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { writeAppliedAstArtifacts } from "../src/applied-ast-artifacts.js"
import { reloadHooksWorker } from "../src/hooks-worker-reload.js"
import type { ComposeWorkerTarget } from "../src/dev-functions-watch.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * FF-11: on a self-host or Docker stack brought up before the first push, the push wrote
 * hooks/_supatype/hooks.ts after the functions worker had started, so every hook failed to load
 * (`Module not found .../_supatype/hooks.ts`) and writes answered 503 until the worker was restarted
 * by hand. A push that writes that file now restarts the worker, as `dev` does on a save.
 */

const config: SupatypeProjectConfig = { project: { name: "acme" } }
const AST = {
  astVersion: 2,
  models: [
    {
      name: "Note",
      fields: {},
      options: {},
      annotations: { db: { tableName: "note" } },
      hooks: { beforeInsert: "check-title" },
    },
  ],
}

let cwd = ""
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-hooks-reload-"))
  mkdirSync(join(cwd, "hooks", "check-title"), { recursive: true })
  writeFileSync(join(cwd, "hooks", "check-title", "index.ts"), "export default () => new Response('ok')\n")
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

describe("a push that writes the hooks module", () => {
  it("says so the first time, and not when the file is unchanged", () => {
    expect(writeAppliedAstArtifacts(cwd, config, AST, { rowCacheEnv: false }).hooksModuleWritten).toBe(true)
    expect(writeAppliedAstArtifacts(cwd, config, AST, { rowCacheEnv: false }).hooksModuleWritten).toBe(false)
  })
})

describe("reloadHooksWorker", () => {
  it("restarts the stack's worker when the hooks module changed", () => {
    const restarted: ComposeWorkerTarget[] = []
    reloadHooksWorker(cwd, config, { hooksModuleWritten: true }, (target) => restarted.push(target))
    expect(restarted).toHaveLength(1)
    expect(restarted[0]?.cwd).toBe(cwd)
    expect(restarted[0]?.composePath).toContain("docker-compose.yml")
  })

  it("leaves it alone when nothing changed", () => {
    const restarted: ComposeWorkerTarget[] = []
    reloadHooksWorker(cwd, config, { hooksModuleWritten: false }, (target) => restarted.push(target))
    expect(restarted).toEqual([])
  })
})
