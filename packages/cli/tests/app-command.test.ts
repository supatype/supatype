import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { scaffold } from "../src/commands/init.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = resolve(__dirname, "../bin/supatype.js")

function runCli(cwd: string, args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd,
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
