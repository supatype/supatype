import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

/**
 * `bin/supatype.js` imports `../dist/cli.js`. In a fresh clone of the monorepo there is no dist
 * until the first build, and running the CLI printed a bare "Cannot find module", which reads like
 * a broken install rather than a missing step. The published package always ships dist, so only
 * the missing-dist case may change.
 */
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/supatype.js")

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-bin-"))
  mkdirSync(join(dir, "bin"))
  copyFileSync(BIN, join(dir, "bin", "supatype.js"))
  // The copy has to be read as ESM, as the package's own `"type": "module"` makes it.
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function runBin(): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [join(dir, "bin", "supatype.js"), "--version"], {
    encoding: "utf8",
    timeout: 30_000,
  })
  return { status: result.status, stderr: String(result.stderr ?? "") }
}

describe("bin/supatype.js", () => {
  it("says to build the monorepo when dist has not been built", () => {
    const { status, stderr } = runBin()
    expect(status).toBe(1)
    expect(stderr).toContain("has not been built")
    expect(stderr).toContain("pnpm install && pnpm build")
  })

  it("reports any other missing module as it is, not as an unbuilt CLI", () => {
    mkdirSync(join(dir, "dist"))
    writeFileSync(join(dir, "dist", "cli.js"), 'import "supatype-no-such-package"\nexport function run() {}\n')
    const { status, stderr } = runBin()
    expect(status).toBe(1)
    expect(stderr).toContain("supatype-no-such-package")
    expect(stderr).not.toContain("has not been built")
  })

  it("runs the built CLI", () => {
    mkdirSync(join(dir, "dist"))
    writeFileSync(join(dir, "dist", "cli.js"), 'export function run() { console.error("ran") }\n')
    const { status, stderr } = runBin()
    expect(status).toBe(0)
    expect(stderr).toContain("ran")
  })
})
