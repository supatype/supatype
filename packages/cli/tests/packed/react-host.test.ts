import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SpawnSyncReturns } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { isJsonObject, isShape } from "@supatype/shared"
import { parseJsonAs } from "../support/json.js"
import { makeMinisign } from "../support/minisign.js"
import { cliCachePath, publishedTarget } from "../../src/cli-program-path.js"
import { parsePackageJson } from "../../src/package-json.js"
import {
  cliDir,
  compileProgram,
  fileSpec,
  mustRun,
  packStagedCli,
  packWorkspacePackage,
  removeStagedPackage,
  run,
  serveRelease,
  stageCliPackage,
  type Mirror,
} from "./release-fixture.js"

/**
 * The CLI as a user installs it: packed, then installed by npm into an app that brings its own
 * React, or none, with the program it runs served from a signed local copy of the release CDN.
 *
 * npm hoists a package's dependencies to the app's root `node_modules` unless the app already has
 * a conflicting version there. With React 19 at the root, `ink` and its `react-reconciler` were
 * hoisted beside it and loaded React 19, while the CLI's own React 18 sat unused one level down.
 * Every command then failed at startup, including `--version` and the scaffold's
 * `prepare: supatype generate`, so `npm install` itself failed and the project could not install.
 *
 * Needs network access for npm and Bun to compile the program, so it runs from `test:packed`, not
 * the default suite. Fetching the schema engine needs the release key, as every source build does:
 * CI passes it in SUPATYPE_RELEASE_PUBLIC_KEY.
 */

const VERSION = `0.0.0-packed.${Date.now()}`
const cliEntry = join("node_modules", "@supatype", "cli", "bin", "supatype.js")

interface Release {
  root: string
  mirror: Mirror
  cli: string
  types: string
  shared: string
}

/**
 * What each app adds at its root beside the scaffold's own dependencies, and which packages are
 * replaced after the install by ones that throw when loaded.
 */
interface Host {
  deps: Record<string, string>
  throwing: string[]
}
const HOSTS: Record<string, Host> = {
  "react-19": { deps: { react: "19.2.0", "react-dom": "19.2.0" }, throwing: [] },
  "react-18": { deps: { react: "18.3.1", "react-dom": "18.3.1" }, throwing: [] },
  "no-react": { deps: {}, throwing: [] },
  "throwing-react": { deps: {}, throwing: ["react", "ink", "react-reconciler"] },
}

/** A package that fails the moment anything loads it, put where npm would hoist the real one. */
function plantThrowingPackage(appDir: string, name: string): void {
  const dir = join(appDir, "node_modules", name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "99.0.0", main: "index.js" }))
  writeFileSync(join(dir, "index.js"), `throw new Error("the app's ${name} was loaded")\n`)
}

async function buildRelease(): Promise<Release> {
  const root = mkdtempSync(join(tmpdir(), "supatype-packed-"))
  const tarballs = join(root, "tarballs")
  mkdirSync(tarballs)
  const shared = packWorkspacePackage("shared", tarballs)
  const types = packWorkspacePackage("types", tarballs)
  const stage = stageCliPackage(VERSION, shared)
  const cli = packStagedCli(stage, tarballs)
  const program = compileProgram(stage, join(root, "program"))
  const mirror = await serveRelease(join(root, "cdn"), VERSION, program)
  return { root, mirror, cli, types, shared }
}

function cliEnv(release: Release, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SUPATYPE_CDN_BASE: release.mirror.base,
    SUPATYPE_RELEASE_PUBLIC_KEY: release.mirror.publicKey,
    ...extra,
  }
}

/**
 * A project as `supatype init` writes it, made by this checkout's CLI, which then generates its
 * types once. That puts the schema engine in the machine's cache, fetched under the machine's own
 * release key: the runs below trust only the throwaway key the test release is signed with, so
 * they could not fetch a real engine themselves.
 */
function scaffold(parent: string): string {
  const cli = join(cliDir, "bin", "supatype.js")
  mkdirSync(parent, { recursive: true })
  mustRun(process.execPath, [cli, "init", "app", "-y", "--no-install", "--no-keys", "--no-admin"], parent)
  mustRun(process.execPath, [cli, "generate"], join(parent, "app"))
  return join(parent, "app")
}

const isScaffoldPackage = isShape({ dependencies: isJsonObject, devDependencies: isJsonObject })

/** The scaffold's package.json with the local tarballs and `host`'s React in place of the registry's. */
function hostPackageJson(scaffoldDir: string, host: Host, release: Release): string {
  const scaffolded = parseJsonAs(readFileSync(join(scaffoldDir, "package.json"), "utf8"), isScaffoldPackage)
  return JSON.stringify({
    ...scaffolded,
    dependencies: { ...scaffolded.dependencies, ...host.deps },
    devDependencies: { ...scaffolded.devDependencies, "@supatype/cli": fileSpec(release.cli), "@supatype/types": fileSpec(release.types) },
    overrides: { "@supatype/shared": fileSpec(release.shared), "@supatype/types": fileSpec(release.types) },
  }, null, 2)
}

/** Installs a copy of the scaffold for `host`. The scaffold's `prepare` runs `supatype generate`. */
function installHost(release: Release, scaffoldDir: string, name: string, host: Host): { dir: string; install: SpawnSyncReturns<string> } {
  const dir = join(release.root, name)
  cpSync(scaffoldDir, dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), hostPackageJson(scaffoldDir, host, release))
  const install = run("npm", ["install", "--no-audit", "--no-fund"], dir, cliEnv(release))
  for (const thrower of host.throwing) plantThrowingPackage(dir, thrower)
  return { dir, install }
}

function rootVersion(appDir: string, name: string): string | undefined {
  return parsePackageJson(readFileSync(join(appDir, "node_modules", name, "package.json"), "utf8")).version
}

function output(result: SpawnSyncReturns<string>): string {
  return `exit ${result.status}\n${result.stdout}\n${result.stderr}`
}

function cachedProgram(home?: string): string {
  return cliCachePath(VERSION, publishedTarget(), home)
}

/** An empty home directory, so the starter finds no cached program and has to download one. */
function freshHome(release: Release): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(release.root, "home-"))
  return { dir, env: { HOME: dir, USERPROFILE: dir } }
}

let built: Release | undefined

/** The release beforeAll built; throws if it failed, so each test reports that instead of a TypeError. */
function current(): Release {
  if (built === undefined) throw new Error("the release was not built")
  return built
}
let scaffoldDir = ""
const apps = new Map<string, string>()

beforeAll(async () => {
  built = await buildRelease()
  scaffoldDir = scaffold(join(built.root, "scaffold-parent"))
}, 600_000)

afterAll(async () => {
  await built?.mirror.close()
  // SUPATYPE_PACKED_KEEP=1 leaves the apps and the cached program, to drive the CLI's interactive
  // screens by hand in a real terminal afterwards.
  if (process.env["SUPATYPE_PACKED_KEEP"] === "1") {
    console.log(`kept: ${built?.root} and ${dirname(cachedProgram())}`)
    return
  }
  if (built !== undefined) rmSync(built.root, { recursive: true, force: true })
  rmSync(dirname(cachedProgram()), { recursive: true, force: true })
  removeStagedPackage(VERSION)
})

describe.each(Object.entries(HOSTS))("the packed CLI in an app with %s at the root", (name, host) => {
  let install: SpawnSyncReturns<string>

  beforeAll(() => {
    const installed = installHost(current(), scaffoldDir, name, host)
    apps.set(name, installed.dir)
    install = installed.install
  }, 600_000)

  const app = (): string => apps.get(name) ?? ""

  it("installs, running the scaffold's prepare: supatype generate", () => {
    expect(install.status, output(install)).toBe(0)
    const react = host.deps["react"]
    if (react !== undefined) expect(rootVersion(app(), "react")).toBe(react)
  })

  it("prints the version it was released as", () => {
    const result = run(process.execPath, [cliEntry, "--version"], app(), cliEnv(current()))
    expect(result.status, output(result)).toBe(0)
    expect(result.stdout.trim()).toBe(VERSION)
  })

  it("generates types", () => {
    rmSync(join(app(), "types"), { recursive: true, force: true })
    const result = run(process.execPath, [cliEntry, "generate"], app(), cliEnv(current()))
    expect(result.status, output(result)).toBe(0)
    expect(existsSync(join(app(), "types", "database.ts"))).toBe(true)
  })
})

// A production image installs without development dependencies, the CLI among them, and npm still
// runs the project's `prepare`. A bare `supatype generate` failed that install with `not found`.
describe("a production install of the scaffold", () => {
  it("installs without the CLI", () => {
    const release = current()
    const dir = join(release.root, "production")
    cpSync(scaffoldDir, dir, { recursive: true })
    writeFileSync(join(dir, "package.json"), hostPackageJson(scaffoldDir, { deps: {}, throwing: [] }, release))
    const install = run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], dir, cliEnv(release))
    expect(install.status, output(install)).toBe(0)
    expect(existsSync(join(dir, "node_modules", "@supatype", "cli"))).toBe(false)
    expect(existsSync(join(dir, "node_modules", "@supatype", "client"))).toBe(true)
  })
})

describe("the npm starter", () => {
  const app = (): string => apps.get("react-19") ?? ""

  it("runs through the package manager's own shim", () => {
    const result = run("npx", ["--no-install", "supatype", "--version"], app(), cliEnv(current()))
    expect(result.status, output(result)).toBe(0)
    expect(result.stdout.trim()).toBe(VERSION)
  })

  it("keeps the program's exit code", () => {
    const viaStarter = run(process.execPath, [cliEntry, "no-such-command"], app(), cliEnv(current()))
    const direct = run(cachedProgram(), ["no-such-command"], app(), cliEnv(current()))
    expect(direct.status).not.toBe(0)
    expect(viaStarter.status, output(viaStarter)).toBe(direct.status)
  })

  it("leaves updating to npm", () => {
    const before = readFileSync(cachedProgram())
    const result = run(process.execPath, [cliEntry, "self-update"], app(), cliEnv(current()))
    expect(result.status, output(result)).toBe(0)
    expect(result.stdout).toContain("installed via npm")
    expect(readFileSync(cachedProgram()).equals(before)).toBe(true)
  })

  // Upgrading leaves the previous version's program behind. Past 250 MB the starter says so, once
  // a day, and `cache clean cli` removes them without touching the running one.
  it("points out old versions once a day, and cleans them", () => {
    const home = freshHome(current())
    const old = dirname(cliCachePath("0.0.1", publishedTarget(), home.dir))
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, "supatype"), "")
    truncateSync(join(old, "supatype"), 300 * 1024 * 1024)

    const first = run(process.execPath, [cliEntry, "--version"], app(), cliEnv(current(), home.env))
    expect(first.status, output(first)).toBe(0)
    expect(first.stderr).toContain("Old CLI versions are using 300.0 MB. Run `supatype cache clean` to remove them.")
    const again = run(process.execPath, [cliEntry, "--version"], app(), cliEnv(current(), home.env))
    expect(again.stderr).not.toContain("Old CLI versions")

    const clean = run(process.execPath, [cliEntry, "cache", "clean", "cli"], app(), cliEnv(current(), home.env))
    expect(clean.status, output(clean)).toBe(0)
    expect(clean.stdout).toContain("removed  cli@0.0.1")
    expect(existsSync(old)).toBe(false)
    expect(existsSync(cachedProgram(home.dir))).toBe(true)
  })

  it("refuses a release signed by a key it does not trust", () => {
    const home = freshHome(current())
    const otherKey = makeMinisign(Buffer.from("another release"), "prehashed").pubKeyStr
    const result = run(process.execPath, [cliEntry, "--version"], app(), cliEnv(current(), { ...home.env, SUPATYPE_RELEASE_PUBLIC_KEY: otherKey }))
    expect(result.status, output(result)).not.toBe(0)
    expect(result.stderr).toMatch(/signature/i)
    expect(existsSync(cachedProgram(home.dir))).toBe(false)
  })

  it("refuses an archive that does not match the signed checksum", () => {
    const home = freshHome(current())
    current().mirror.tamper()
    const result = run(process.execPath, [cliEntry, "--version"], app(), cliEnv(current(), home.env))
    expect(result.status, output(result)).not.toBe(0)
    expect(result.stderr).toContain("Checksum mismatch")
    expect(existsSync(cachedProgram(home.dir))).toBe(false)
  })

  it("runs offline once the program is cached", async () => {
    await current().mirror.close()
    const result = run(process.execPath, [cliEntry, "--version"], app(), cliEnv(current()))
    expect(result.status, output(result)).toBe(0)
    expect(result.stdout.trim()).toBe(VERSION)
  })
})
