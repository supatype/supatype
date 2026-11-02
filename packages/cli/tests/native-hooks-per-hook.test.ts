import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { writeAppliedAstArtifacts } from "../src/applied-ast-artifacts.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Per-hook deploys in native dev (Nic, 2026-11-01): the worker serves hooks from the project's own
 * hooks/ directory, so a local push must never delete or rewrite a hook's files, a broken one
 * included: it keeps what it has (the worker answers its route 500 when it fails to load, and 503
 * when it has no code, either of which refuses the write under the default policy).
 */
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("a local push with a hook that does not load", () => {
  it("leaves every file of that hook exactly as it is", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supatype-native-hooks-"))
    dirs.push(cwd)
    mkdirSync(join(cwd, ".supatype"), { recursive: true })
    writeFileSync(join(cwd, ".supatype", "manifest.json"), "{}")
    const broken = join(cwd, "hooks", "tag-note")
    mkdirSync(join(broken, "lib"), { recursive: true })
    writeFileSync(join(broken, "index.ts"), 'import { x } from "./lib/missing.ts"\nexport default () => x\n')
    writeFileSync(join(broken, "lib", "a.ts"), "export const a = 1 +\n")
    const before = ["index.ts", "lib/a.ts"].map((file) => [readFileSync(join(broken, file), "utf8"), statSync(join(broken, file)).mtimeMs])
    const ast = {
      models: [{ name: "Note", fields: {}, annotations: { db: { tableName: "note" }, platform: { hooks: { beforeChange: { function: "tag-note" } } } } }],
    }

    writeAppliedAstArtifacts(cwd, projectConfig(), ast, { rowCacheEnv: false })

    const after = ["index.ts", "lib/a.ts"].map((file) => [readFileSync(join(broken, file), "utf8"), statSync(join(broken, file)).mtimeMs])
    expect(after).toEqual(before)
    // The map still names it, so the table's writes go to the hook, and are refused while it is broken.
    expect(readFileSync(join(cwd, ".supatype", "manifest.json"), "utf8")).toContain("tag-note")
  })
})
