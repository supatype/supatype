import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"

/**
 * After `app add` or `app remove` the CLI said "Next: supatype self-host compose render" whatever
 * the project was. A dev project's routing is served by `supatype dev`, and a running dev stack
 * keeps serving the old app until it restarts, so that is what it is told.
 */

const CLI_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/supatype.js")
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(serverMode: "dev" | "standalone"): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-app-next-"))
  dirs.push(dir)
  scaffold(dir, defaultScaffoldOptions("app-next"))
  const configPath = join(dir, "supatype.config.ts")
  writeFileSync(configPath, readFileSync(configPath, "utf8").replace('mode: "dev"', `mode: "${serverMode}"`))
  return dir
}

function run(cwd: string, args: string[]): string {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], { cwd, encoding: "utf8", timeout: 60_000 })
  expect(result.status, result.stderr).toBe(0)
  return `${result.stdout}${result.stderr}`
}

describe("the next step after app add and app remove", () => {
  it.each([
    ["add", "--upstream", "http://localhost:5173"],
    ["add", "--static", "./public"],
    ["remove"],
  ])("tells a dev project to restart supatype dev (app %s)", (...args) => {
    const out = run(project("dev"), ["app", ...args])
    expect(out).toContain("Restart `supatype dev`")
    expect(out).not.toContain("self-host compose")
  })

  it.each([
    ["add", "--upstream", "http://localhost:5173"],
    ["remove"],
  ])("tells a self-host project to bring compose up, which renders it (app %s)", (...args) => {
    const out = run(project("standalone"), ["app", ...args])
    expect(out).toContain("supatype self-host compose up -d")
    // `compose up` writes the compose file itself, so a separate render step is noise.
    expect(out).not.toContain("compose render")
    expect(out).not.toContain("supatype dev")
  })
})
