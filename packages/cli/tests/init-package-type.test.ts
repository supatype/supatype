/**
 * FF24 (0.9.1, still open in the 0.9.2 release test): init merged `"type": "module"` into an existing
 * app's package.json. An Expo app's server export is CommonJS, so with it `npx expo serve` answered
 * every page 500 (`ERR_REQUIRE_CYCLE_MODULE` on `dist/server/_expo/server/render.js`). The app's own
 * package.json decides how its own JavaScript loads; only a package.json init writes from scratch
 * gets the field.
 *
 * Nothing init writes into an existing app needs it. supatype.config.ts, schema/index.ts and seed.ts
 * are run by the CLI's own TypeScript runner, which loads them in a CommonJS package too (config.test
 * loads configs with no package.json at all; seed-commonjs-project.test covers a seed). The one file
 * a tool other than the CLI loads is a new vite.config, written as `vite.config.mts` in a package
 * that is not ESM, which Vite loads as ESM by its extension.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b-init-pkg-type-"))
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function packageType(): unknown {
  const pkg: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  return typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "type") : undefined
}

const VITE_APP = { mode: "static" as const, staticDir: "./dist", viteDevUrl: "http://127.0.0.1:5173" }

describe("the package type init leaves", () => {
  it("is not added to an existing app's package.json (create-expo-app has none)", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "b-init-expo", main: "expo-router/entry" }))
    scaffold(dir, defaultScaffoldOptions("b-init-expo"))
    expect(packageType()).toBeUndefined()
  })

  it("keeps the type an existing app already has", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "b-init-cjs", type: "commonjs" }))
    scaffold(dir, defaultScaffoldOptions("b-init-cjs"))
    expect(packageType()).toBe("commonjs")
  })

  it("is module in a package.json init writes from scratch", () => {
    scaffold(dir, defaultScaffoldOptions("b-init-new"))
    expect(packageType()).toBe("module")
  })
})

describe("the vite.config init writes", () => {
  it("is vite.config.mts in an existing package that is not ESM, so Vite loads it as ESM", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "b-init-cjs-vite" }))
    scaffold(dir, { ...defaultScaffoldOptions("b-init-cjs-vite"), app: VITE_APP })
    expect(existsSync(join(dir, "vite.config.mts"))).toBe(true)
    expect(existsSync(join(dir, "vite.config.ts"))).toBe(false)
  })

  it("is vite.config.ts in a new project", () => {
    scaffold(dir, { ...defaultScaffoldOptions("b-init-new-vite"), app: VITE_APP })
    expect(existsSync(join(dir, "vite.config.ts"))).toBe(true)
  })

  it("is not written beside an existing vite.config.mts", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "b-init-mts", type: "module" }))
    writeFileSync(join(dir, "vite.config.mts"), "export default {}\n")
    scaffold(dir, { ...defaultScaffoldOptions("b-init-mts"), app: VITE_APP })
    expect(existsSync(join(dir, "vite.config.ts"))).toBe(false)
  })
})
