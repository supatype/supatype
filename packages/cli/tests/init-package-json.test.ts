import { afterEach, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergeSupatypePackageJson, PREPARE_COMMAND, scaffoldPackageJson } from "../src/init-package-json.js"

const DEPS = { cli: "0.1.1", types: "0.1.1", client: "0.1.1" }
const NO_APP = { projectName: "existing", app: { mode: "none" }, helloFunction: false }
const VITE_APP = { projectName: "existing", app: { mode: "static", viteDevUrl: "http://127.0.0.1:5173" }, helloFunction: false }

describe("mergeSupatypePackageJson", () => {
  it("adds Supatype deps and scripts without overwriting existing dev script", () => {
    const merged = mergeSupatypePackageJson({ name: "existing", scripts: { dev: "next dev" } }, NO_APP, DEPS)

    expect(merged.scripts?.dev).toBe("next dev")
    expect(merged.scripts?.["supatype:dev"]).toBe("supatype dev")
    expect(merged.scripts?.push).toBe("supatype push")
  })

  // The same split a new project gets: in dependencies, `npm install --omit=dev` installed the CLI
  // into every production build of the app.
  it("adds the CLI and types as development dependencies", () => {
    const merged = mergeSupatypePackageJson({ name: "existing" }, NO_APP, DEPS)

    expect(merged.devDependencies?.["@supatype/cli"]).toBe("^0.1.1")
    expect(merged.devDependencies?.["@supatype/types"]).toBe("^0.1.1")
    expect(merged.dependencies?.["@supatype/cli"]).toBeUndefined()
    expect(merged.dependencies?.["@supatype/client"]).toBe("^0.1.1")
  })

  it("leaves the CLI where a project already lists it", () => {
    const merged = mergeSupatypePackageJson({ dependencies: { "@supatype/cli": "0.0.9" } }, NO_APP, DEPS)

    expect(merged.dependencies?.["@supatype/cli"]).toBe("0.0.9")
    expect(merged.devDependencies?.["@supatype/cli"]).toBeUndefined()
  })

  // `tsx seed.ts` loaded the seed module without calling the function it exports.
  it("runs seeds the way a new project does", () => {
    const merged = mergeSupatypePackageJson({ name: "existing" }, NO_APP, DEPS)

    expect(merged.scripts?.seed).toBe("supatype seed")
  })

  it("generates on install, as a new project does", () => {
    expect(mergeSupatypePackageJson({ name: "existing" }, NO_APP, DEPS).scripts?.prepare).toBe(PREPARE_COMMAND)
  })

  it("leaves @supatype/client where a project already lists it", () => {
    const merged = mergeSupatypePackageJson({ devDependencies: { "@supatype/client": "^0.6.0" } }, NO_APP, DEPS)

    expect(merged.dependencies?.["@supatype/client"]).toBeUndefined()
    expect(merged.devDependencies?.["@supatype/client"]).toBe("^0.6.0")
  })

  it("keeps the project's own scripts, in their order, ahead of the ones it adds", () => {
    const merged = mergeSupatypePackageJson({ scripts: { prepare: "husky", build: "tsc" } }, VITE_APP, DEPS)

    expect(merged.scripts?.prepare).toBe("husky")
    expect(merged.scripts?.build).toBe("tsc")
    expect(Object.keys(merged.scripts ?? {}).slice(0, 2)).toEqual(["prepare", "build"])
  })

  // The CLI's program runs the project's TypeScript itself, so tsx only took up space in every app.
  it("adds TypeScript but not tsx", () => {
    const merged = mergeSupatypePackageJson({ name: "existing" }, NO_APP, DEPS)

    expect(merged.devDependencies?.typescript).toBe("^5")
    expect(merged.devDependencies?.tsx).toBeUndefined()
  })

  it("adds Vite 8 and a build for a Vite app", () => {
    const merged = mergeSupatypePackageJson({ name: "existing" }, VITE_APP, DEPS)

    expect(merged.devDependencies?.vite).toBe("^8")
    expect(merged.scripts?.build).toBe("vite build")
  })
})

describe("scaffoldPackageJson", () => {
  it("writes the same scripts and dependencies a merge adds", () => {
    const written: unknown = JSON.parse(scaffoldPackageJson(VITE_APP, DEPS))
    const merged = mergeSupatypePackageJson({}, VITE_APP, DEPS)

    expect(written).toMatchObject({ scripts: merged.scripts, devDependencies: merged.devDependencies, version: "0.1.0" })
  })
})

/**
 * The project's `prepare`, run the way npm runs it: through the shell, in the project. A production
 * install leaves out development dependencies, the CLI with them, and still runs `prepare`, where
 * a bare `supatype generate` failed the install with `supatype: not found`.
 */
describe("the prepare script", () => {
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

  /**
   * A stand-in CLI whose `generate` records that it ran, and exits with `status`. Its `exports`
   * do not name its package.json, as no release's do: it is found all the same.
   */
  function installCli(dir: string, status: number, folder = "node_modules"): void {
    const cli = join(dir, folder, "@supatype", "cli")
    mkdirSync(join(cli, "bin"), { recursive: true })
    writeFileSync(join(cli, "package.json"), '{ "name": "@supatype/cli", "exports": { ".": "./index.js" } }\n')
    const script = `require("node:fs").writeFileSync("generated", process.argv[2]); process.exit(${status})`
    writeFileSync(join(cli, "bin", "supatype.js"), `${script}\n`)
  }

  const prepare = (cwd: string, env: NodeJS.ProcessEnv = {}) =>
    spawnSync(PREPARE_COMMAND, { cwd, shell: true, encoding: "utf8", env: { ...process.env, ...env } })

  it("succeeds, and generates nothing, where the CLI is not installed", () => {
    const dir = project()
    const result = prepare(dir)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(dir, "generated"))).toBe(false)
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
    expect(existsSync(join(dir, "generated"))).toBe(false)
  })

  // A workspace member can pin a CLI of its own beside the one the root hoists.
  it("runs the nearest CLI", () => {
    const root = project()
    installCli(root, 4)
    const pkg = join(root, "packages", "app")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, "package.json"), '{ "type": "module" }\n')
    installCli(pkg, 0)
    const result = prepare(pkg)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(pkg, "generated"))).toBe(true)
  })

  it("runs supatype generate where the CLI is installed", () => {
    const dir = project()
    installCli(dir, 0)
    const result = prepare(dir)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(dir, "generated"))).toBe(true)
  })

  // A workspace hoists the CLI to the root's node_modules, above the package that runs prepare.
  it("finds a CLI hoisted into a parent directory", () => {
    const root = project()
    installCli(root, 0)
    const pkg = join(root, "packages", "app")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, "package.json"), '{ "type": "module" }\n')
    const result = prepare(pkg)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(pkg, "generated"))).toBe(true)
  })

  // A node_modules above the project that is a file, or one the user may not read, holds no CLI.
  // Node's own lookup passes over it: failing on it failed an install that had nothing to run.
  it("passes over a node_modules it cannot look inside", () => {
    const root = project()
    writeFileSync(join(root, "node_modules"), "")
    const pkg = join(root, "app")
    mkdirSync(pkg)
    const result = prepare(pkg)
    expect(result.status, result.stderr).toBe(0)
  })

  // A folder with nothing behind it, as a link into a pruned pnpm store leaves: skipping it would
  // pass the install and fail the build later, on generated files that were never written.
  it("fails the install when the CLI folder is there but broken", () => {
    const dir = project()
    mkdirSync(join(dir, "node_modules", "@supatype", "cli"), { recursive: true })
    expect(prepare(dir).status).not.toBe(0)
  })

  it("fails the install when generate fails", () => {
    const dir = project()
    installCli(dir, 3)
    expect(prepare(dir).status).toBe(3)
  })

  // The script is one double-quoted argument to node under sh and cmd.exe alike. A quote or a
  // backslash in it would end or change that argument, a redirect would split it if a quote were
  // ever lost, and cmd.exe with delayed expansion strips a lone `!`, which turned `if(!d)` into
  // `if(d)`.
  it("holds no character a shell would rewrite inside double quotes", () => {
    const body = /^node -e "(.*)"$/.exec(PREPARE_COMMAND)?.[1]
    expect(body).toBeDefined()
    expect(body).not.toMatch(/[!$`%"\\<>|&]/)
  })
})
