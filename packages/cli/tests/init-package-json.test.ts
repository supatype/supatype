import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mergeSupatypePackageJson, supatypeDevScript } from "../src/init-package-json.js"
import { defaultScaffoldOptions, scaffold, type ScaffoldOptions } from "../src/commands/init.js"
import { isJsonObject, parseJsonObject } from "@supatype/shared"

const DEPS = { cli: "0.1.1", types: "0.1.1", client: "0.1.1", vite: "8.1.2" }
const NO_APP = { projectName: "existing", app: { mode: "none" }, helloFunction: false }
const VITE_APP = { projectName: "existing", app: { mode: "static", viteDevUrl: "http://127.0.0.1:5173" }, helloFunction: false }

describe("mergeSupatypePackageJson", () => {
  it("adds Supatype deps and scripts without overwriting existing dev script", () => {
    const merged = mergeSupatypePackageJson({ name: "existing", scripts: { dev: "next dev" } }, NO_APP, DEPS)

    expect(merged.devDependencies?.["@supatype/cli"]).toBe("^0.1.1")
    expect(merged.devDependencies?.["@supatype/types"]).toBe("^0.1.1")
    expect(merged.dependencies?.["@supatype/client"]).toBe("^0.1.1")
    expect(merged.scripts?.dev).toBe("next dev")
    expect(merged.scripts?.["supatype:dev"]).toBe("supatype dev")
    expect(merged.scripts?.push).toBe("supatype push")
  })

  // A project's own `prepare` (husky, say) was kept as it was, so a fresh clone never generated the
  // gitignored seed builder. `supatype generate` is chained after it, once.
  it("chains supatype generate after a prepare script of the project's own, once", () => {
    const merged = mergeSupatypePackageJson({ scripts: { prepare: "husky" } }, NO_APP, DEPS)
    expect(merged.scripts?.prepare).toBe("husky && supatype generate")
    expect(mergeSupatypePackageJson(merged, NO_APP, DEPS).scripts?.prepare).toBe("husky && supatype generate")
    expect(mergeSupatypePackageJson({ scripts: { prepare: "supatype generate" } }, NO_APP, DEPS).scripts?.prepare).toBe(
      "supatype generate",
    )
  })

  it("sets a version only when the project has none", () => {
    expect(mergeSupatypePackageJson({ name: "existing" }, NO_APP, DEPS).version).toBe("0.1.0")
    expect(mergeSupatypePackageJson({ name: "existing", version: "3.2.1" }, NO_APP, DEPS).version).toBe("3.2.1")
  })

  it("adds vite build beside the vite script, keeping a build the project already has", () => {
    expect(mergeSupatypePackageJson({}, VITE_APP, DEPS).scripts?.build).toBe("vite build")
    expect(mergeSupatypePackageJson({ scripts: { build: "tsc -b && vite build" } }, VITE_APP, DEPS).scripts?.build).toBe(
      "tsc -b && vite build",
    )
    expect(mergeSupatypePackageJson({}, NO_APP, DEPS).scripts?.build).toBeUndefined()
  })

  it("pins Vite to the version resolved at init", () => {
    expect(mergeSupatypePackageJson({}, VITE_APP, DEPS).devDependencies?.vite).toBe("^8.1.2")
  })

  it("names the script that runs supatype dev, for the next steps", () => {
    expect(supatypeDevScript(mergeSupatypePackageJson({}, NO_APP, DEPS).scripts)).toBe("dev")
    expect(supatypeDevScript(mergeSupatypePackageJson({ scripts: { dev: "next dev" } }, NO_APP, DEPS).scripts)).toBe("supatype:dev")
    expect(supatypeDevScript(undefined)).toBe("dev")
  })

  it("does not add a Supatype package the project already lists under dependencies", () => {
    const merged = mergeSupatypePackageJson({ dependencies: { "@supatype/cli": "^0.0.9" } }, NO_APP, DEPS)
    expect(merged.dependencies?.["@supatype/cli"]).toBe("^0.0.9")
    expect(merged.devDependencies?.["@supatype/cli"]).toBeUndefined()
  })
})

/**
 * A new package.json and one merged into an existing project used to be written by two copies that
 * had drifted: the merge ran `tsx seed.ts`, which imports the seed and runs nothing, had no
 * `prepare`, so a fresh clone had no seed builder, and put the CLI toolchain in `dependencies`.
 */
describe("init's package.json, new and merged", () => {
  let dir = ""
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-init-pkg-"))
    vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  const viteOptions = (): ScaffoldOptions => ({
    ...defaultScaffoldOptions("acme", "self-host"),
    app: { mode: "static", staticDir: "./dist", viteDevUrl: "http://127.0.0.1:5173" },
  })

  function written(): Record<string, unknown> {
    const parsed = parseJsonObject(readFileSync(join(dir, "package.json"), "utf8"))
    if (!parsed.ok) throw new Error("package.json is not a JSON object")
    return parsed.value
  }

  it("gives a new project a version, a build script and the resolved Vite", () => {
    scaffold(dir, viteOptions(), DEPS)
    const pkg = written()
    expect(pkg["version"]).toBe("0.1.0")
    const scripts = pkg["scripts"]
    const devDependencies = pkg["devDependencies"]
    if (!isJsonObject(scripts) || !isJsonObject(devDependencies)) throw new Error("missing sections")
    expect(scripts["build"]).toBe("vite build")
    expect(devDependencies["vite"]).toBe("^8.1.2")
  })

  it("writes the same scripts and dependencies as a merge into an empty package.json", () => {
    const opts = viteOptions()
    scaffold(dir, opts, DEPS)
    const pkg = written()
    const merged = mergeSupatypePackageJson({}, opts, DEPS)
    expect(pkg["scripts"]).toEqual(merged.scripts)
    expect(pkg["dependencies"]).toEqual(merged.dependencies)
    expect(pkg["devDependencies"]).toEqual(merged.devDependencies)
  })
})
