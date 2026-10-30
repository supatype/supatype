import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, tempProject } from "./support/command-run.js"

// `plugins add` runs the package manager; the test is about what is said afterwards, not npm.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawnSync: () => ({ status: 0, stdout: "", stderr: "", pid: 0, output: [], signal: null }) }
})

import { registerPlugins } from "../src/commands/plugins.js"

/**
 * Nothing in Supatype loads a plugin yet: not the engine, the server, Studio or the schema compiler.
 * `plugins add` still said "<pkg> installed and registered." and `plugins list` called every
 * compatible plugin "active", so a developer reasonably expected a field type or widget to work and
 * got nothing. Both now say the plugin is installed and that Supatype does not load plugins yet.
 */
let project: { dir: string; remove: () => void }

function installPlugin(dir: string): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "supatype-plugin-money": "1.0.0" } }))
  const pkgDir = join(dir, "node_modules", "supatype-plugin-money")
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "supatype-plugin-money", version: "1.0.0", supatype: { pluginApi: 1, types: ["field"] } }),
  )
}

beforeEach(() => {
  project = tempProject("plugins")
  installPlugin(project.dir)
})

afterEach(() => {
  project.remove()
})

describe("plugins", () => {
  it("add says the plugin is installed, not registered, and that plugins are not loaded yet", async () => {
    const run = await runCommand(registerPlugins, ["plugins", "add", "supatype-plugin-money"], project.dir)

    expect(run.output).not.toContain("registered")
    expect(run.output).toContain("supatype-plugin-money installed.")
    expect(run.output).toContain("Supatype does not load plugins yet")
  })

  it("list reports a compatible plugin as installed, not active", async () => {
    const run = await runCommand(registerPlugins, ["plugins", "list"], project.dir)

    expect(run.output).toContain("supatype-plugin-money")
    expect(run.output).not.toContain("active")
    expect(run.output).toMatch(/supatype-plugin-money\s+field\s+1\.0\.0\s+installed/)
    expect(run.output).toContain("Supatype does not load plugins yet")
  })
})
