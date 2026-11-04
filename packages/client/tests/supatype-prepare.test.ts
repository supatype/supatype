import { afterEach, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BIN = join(import.meta.dirname, "..", "bin", "supatype-prepare.js")

/**
 * `supatype-prepare`, a project's `prepare`, run in the project as npm runs it. A production
 * install leaves out development dependencies, the CLI with them, and still runs `prepare`, where
 * a bare `supatype generate` failed the install with `supatype: not found`.
 */
describe("supatype-prepare", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function project(): string {
    const dir = mkdtempSync(join(tmpdir(), "supatype-prepare-"))
    dirs.push(dir)
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n')
    return dir
  }

  /** A workspace member under `root`, with no node_modules of its own. */
  function member(root: string): string {
    const pkg = join(root, "packages", "app")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, "package.json"), '{ "type": "module" }\n')
    return pkg
  }

  /**
   * A stand-in CLI whose `generate` records that it ran, and exits with `status`. Its `exports` do
   * not name its package.json, as no release's do: it is found all the same.
   */
  function installCli(dir: string, status: number, folder = "node_modules", bin: string | object = { supatype: "./bin/supatype.js" }): void {
    const cli = join(dir, folder, "@supatype", "cli")
    mkdirSync(join(cli, "bin"), { recursive: true })
    const manifest = { name: "@supatype/cli", bin, exports: { ".": "./index.js" } }
    writeFileSync(join(cli, "package.json"), JSON.stringify(manifest))
    const script = `require("node:fs").writeFileSync("generated", process.argv[2]); process.exit(${status})`
    writeFileSync(join(cli, "bin", "supatype.js"), `${script}\n`)
  }

  const prepare = (cwd: string, env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [BIN], { cwd, encoding: "utf8", env: { ...process.env, ...env } })

  const generated = (dir: string): boolean => existsSync(join(dir, "generated"))

  it("succeeds, and generates nothing, where the CLI is not installed", () => {
    const dir = project()
    const result = prepare(dir)
    expect(result.status, result.stderr).toBe(0)
    expect(generated(dir)).toBe(false)
  })

  // pnpm's bin shims point NODE_PATH at pnpm's store, and Node's global folders include
  // ~/.node_modules: neither is this project's, and a production install that left the CLI out
  // must not run some other copy.
  it.each([
    ["on NODE_PATH", "node_modules", (dir: string) => ({ NODE_PATH: join(dir, "node_modules") })],
    ["in the home folder's .node_modules", ".node_modules", (dir: string) => ({ HOME: dir, USERPROFILE: dir })],
  ] as const)("ignores a CLI %s", (_, folder, env) => {
    const elsewhere = project()
    installCli(elsewhere, 0, folder)
    const dir = project()
    const result = prepare(dir, env(elsewhere))
    expect(result.status, result.stderr).toBe(0)
    expect(generated(dir)).toBe(false)
  })

  // npm reads `bin` given as a string as the package's one command.
  it.each([
    ["named", { supatype: "./bin/supatype.js" }],
    ["given as a string", "./bin/supatype.js"],
  ] as const)("runs supatype generate where the CLI is installed, its bin %s", (_, bin) => {
    const dir = project()
    installCli(dir, 0, "node_modules", bin)
    const result = prepare(dir)
    expect(result.status, result.stderr).toBe(0)
    expect(generated(dir)).toBe(true)
  })

  // A workspace hoists the CLI to the root's node_modules, above the package that runs prepare.
  it("finds a CLI hoisted into a parent directory", () => {
    const root = project()
    installCli(root, 0)
    const pkg = member(root)
    const result = prepare(pkg)
    expect(result.status, result.stderr).toBe(0)
    expect(generated(pkg)).toBe(true)
  })

  // A workspace member can pin a CLI of its own beside the one the root hoists.
  it("runs the nearest CLI", () => {
    const root = project()
    installCli(root, 4)
    const pkg = member(root)
    installCli(pkg, 0)
    const result = prepare(pkg)
    expect(result.status, result.stderr).toBe(0)
    expect(generated(pkg)).toBe(true)
  })

  // A node_modules above the project that is a file, or one the user may not read, holds no CLI.
  // Node's own lookup passes over it. Only Linux and macOS report a file there as ENOTDIR.
  it("passes over a node_modules it cannot look inside", () => {
    const root = project()
    writeFileSync(join(root, "node_modules"), "")
    const pkg = member(root)
    const result = prepare(pkg)
    expect(result.status, result.stderr).toBe(0)
  })

  // A link into a pruned pnpm store, an empty folder, a package.json naming no command: skipping
  // any of them would pass the install and fail the build later, on files never generated.
  it.each([
    ["a link to nothing", (cli: string) => symlinkSync(join(cli, "..", "gone"), cli, "junction")],
    ["an empty folder", (cli: string) => mkdirSync(cli)],
    ["a CLI naming no supatype command", (cli: string) => installCli(join(cli, "..", "..", ".."), 0, "node_modules", { other: "./x.js" })],
  ] as const)("fails the install when the CLI folder is %s", (_, make) => {
    const dir = project()
    const cli = join(dir, "node_modules", "@supatype", "cli")
    mkdirSync(join(cli, ".."), { recursive: true })
    make(cli)
    const result = prepare(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("cannot read the Supatype CLI")
  })

  it("fails the install when generate fails", () => {
    const dir = project()
    installCli(dir, 3)
    expect(prepare(dir).status).toBe(3)
  })
})
