import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { spawnSync } from "node:child_process"
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

/** The bin script into `binDir`, with the Node version check it imports first. */
function copyBin(binDir: string): void {
  copyFileSync(BIN, join(binDir, "supatype.js"))
  copyFileSync(join(dirname(BIN), "node-version.js"), join(binDir, "node-version.js"))
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-bin-"))
  mkdirSync(join(dir, "bin"))
  copyBin(join(dir, "bin"))
  // The copy has to be read as ESM, as the package's own `"type": "module"` makes it.
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n')
  // As in the monorepo, where the JavaScript's development dependencies are installed.
  mkdirSync(join(dir, "node_modules", "commander"), { recursive: true })
  writeFileSync(join(dir, "node_modules", "commander", "package.json"), '{ "name": "commander", "main": "index.js" }\n')
  writeFileSync(join(dir, "node_modules", "commander", "index.js"), "\n")
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

/**
 * Installed from npm, the package starts the compiled program instead of its own JavaScript, whose
 * Ink and React would resolve against the app's `node_modules`. Both entries are stubs here: what
 * is under test is which one the bin chooses.
 */
describe("bin/supatype.js installed under node_modules", () => {
  let app: string
  let pkg: string

  beforeEach(() => {
    app = mkdtempSync(join(tmpdir(), "supatype-bin-app-"))
    pkg = join(app, "node_modules", "@supatype", "cli")
    mkdirSync(join(pkg, "bin"), { recursive: true })
    mkdirSync(join(pkg, "dist"))
    copyBin(join(pkg, "bin"))
    writeFileSync(join(pkg, "package.json"), '{ "type": "module" }\n')
    writeFileSync(join(pkg, "dist", "cli.js"), 'export function run() { console.error("ran the JavaScript CLI") }\n')
    writeFileSync(join(pkg, "dist", "cli-launcher.js"), 'export function run() { console.error("launched the program") }\n')
  })

  afterEach(() => {
    rmSync(app, { recursive: true, force: true })
  })

  it("starts the compiled program", () => {
    const result = spawnSync(process.execPath, [join(pkg, "bin", "supatype.js"), "--version"], { encoding: "utf8", timeout: 30_000 })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain("launched the program")
    expect(result.stderr).not.toContain("ran the JavaScript CLI")
  })

  // Deno keeps npm packages in a cache of its own, with no node_modules in the path; neither is
  // there one for a copied package. The JavaScript's dependencies are not there either.
  it("starts the compiled program from outside node_modules when the JavaScript could not run", () => {
    const copy = mkdtempSync(join(tmpdir(), "supatype-bin-copy-"))
    try {
      cpSync(pkg, copy, { recursive: true })
      const result = spawnSync(process.execPath, [join(copy, "bin", "supatype.js"), "--version"], { encoding: "utf8", timeout: 30_000 })
      expect(result.status).toBe(0)
      expect(result.stderr).toContain("launched the program")
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
})
