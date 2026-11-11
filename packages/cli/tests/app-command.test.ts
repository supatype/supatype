import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { scaffold } from "../src/commands/init.js"
import { devSessionLockFor, writeDevSessionLock } from "../src/dev-session-lock.js"
import { selfHostComposePaths } from "../src/self-host-compose.js"
import { projectConfig } from "./support/project-config.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = resolve(__dirname, "../bin/supatype.js")

function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd,
    env,
    encoding: "utf8",
    // 60s, not 10s: this spawns the built CLI, which imports Ink, React and commander before it
    // does anything. That is about 1.2s idle, and CI runs `turbo run test` across every package at
    // once, where it exceeded 10s and the subprocess was killed. The assertion then compared
    // against empty output and pointed at the CLI rather than at contention.
    timeout: 60_000,
  })
  if (result.signal) {
    throw new Error(
      `CLI subprocess killed by ${result.signal} after the spawn timeout. `
        + `Args: ${args.join(" ")}. This is usually machine contention, not a CLI fault.`,
    )
  }
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    exitCode: result.status ?? 1,
  }
}

let tmpRoot: string

beforeEach(() => {
  tmpRoot = join(tmpdir(), `dt-app-test-${Date.now()}`)
  mkdirSync(tmpRoot, { recursive: true })
  scaffold(tmpRoot, "app-test")
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe("supatype app add --static", () => {
  it("sets app.mode=static and static_dir in supatype.config.ts", () => {
    const { exitCode } = runCli(tmpRoot, ["app", "add", "--static", "./public"])
    expect(exitCode).toBe(0)
    const config = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    expect(config).toContain('mode: "static"')
    expect(config).toContain('static_dir: "./public"')
  })

  it("creates the static directory when missing", () => {
    const siteDir = join(tmpRoot, "site")
    expect(existsSync(siteDir)).toBe(false)
    const { exitCode } = runCli(tmpRoot, ["app", "add", "--static", "./site"])
    expect(exitCode).toBe(0)
    expect(existsSync(siteDir)).toBe(true)
  })
})

// 0.9.2 release test round 5 (S-2): with this folder's dev session running and another Kong port in
// the shell, `app add` wrote the config and made the directory, and only then refused the port.
describe("supatype app add, refused by a running dev session's ports", () => {
  /** A live dev session of this folder on Kong 18740: the test runner's pid stands in for dev's. */
  function devSession(): void {
    const config = projectConfig({ project: { name: "app-test" }, provider: "docker", database: { provider: "docker" } })
    const stack = { composeProject: "supatype-app-test", composePath: selfHostComposePaths(tmpRoot).composePath, kongPort: 18740 }
    writeDevSessionLock(tmpRoot, devSessionLockFor(config, stack))
  }

  it.each([
    ["--static", ["app", "add", "--static", "./site"]],
    ["a proxy", ["app", "add", "--port", "5173"]],
  ])("writes nothing for %s", (_kind, args) => {
    devSession()
    const before = readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")
    const { exitCode, stderr, stdout } = runCli(tmpRoot, args, { ...process.env, SUPATYPE_KONG_PORT: "18741" })
    expect(exitCode).toBe(1)
    expect(stdout + stderr).toContain("SUPATYPE_KONG_PORT=18741")
    expect(readFileSync(join(tmpRoot, "supatype.config.ts"), "utf8")).toBe(before)
    expect(existsSync(join(tmpRoot, "site"))).toBe(false)
  })
})
