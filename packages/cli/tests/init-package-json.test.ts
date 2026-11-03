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

  /** A stand-in CLI whose `generate` records that it ran, and exits with `status`. */
  function installCli(dir: string, status: number): void {
    const cli = join(dir, "node_modules", "@supatype", "cli")
    mkdirSync(join(cli, "bin"), { recursive: true })
    writeFileSync(join(cli, "package.json"), '{ "name": "@supatype/cli" }\n')
    const script = `require("node:fs").writeFileSync("generated", process.argv[2]); process.exit(${status})`
    writeFileSync(join(cli, "bin", "supatype.js"), `${script}\n`)
  }

  const prepare = (cwd: string) => spawnSync(PREPARE_COMMAND, { cwd, shell: true, encoding: "utf8" })

  it("succeeds, and generates nothing, where the CLI is not installed", () => {
    const dir = project()
    const result = prepare(dir)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(dir, "generated"))).toBe(false)
  })

  it("runs supatype generate where the CLI is installed", () => {
    const dir = project()
    installCli(dir, 0)
    const result = prepare(dir)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(dir, "generated"))).toBe(true)
  })

  it("fails the install when generate fails", () => {
    const dir = project()
    installCli(dir, 3)
    expect(prepare(dir).status).toBe(3)
  })
})
