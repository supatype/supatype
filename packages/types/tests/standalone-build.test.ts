import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const packageTsconfig = resolve(here, "..", "tsconfig.json")
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc")

/**
 * The Cloud control plane image builds this package in a bare directory with no node_modules, so no
 * `@types/node`. A name the package takes from the Node typings alone then fails that build with
 * TS2304, while every build inside the monorepo, where the typings are hoisted, passes.
 */
describe("@supatype/types builds with no ambient typings", () => {
  it("typechecks with `types` empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "types-standalone-"))
    try {
      const config = join(dir, "tsconfig.json")
      writeFileSync(config, JSON.stringify({ extends: packageTsconfig, compilerOptions: { types: [], noEmit: true, composite: false, incremental: false }, files: [resolve(here, "..", "src", "index.ts")] }))
      let output = ""
      try {
        execFileSync(process.execPath, [tsc, "--project", config], { encoding: "utf8", stdio: "pipe" })
      } catch (error) {
        output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error)
      }
      expect(output).toBe("")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
