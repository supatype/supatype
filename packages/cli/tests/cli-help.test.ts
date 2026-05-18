/**
 * Subprocess tests — spawn the compiled CLI binary and verify commands are
 * registered. Requires `pnpm build` to have run first (turbo handles this).
 */
import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = resolve(__dirname, "../bin/supatype.js")
const DIST_CLI = resolve(__dirname, "../dist/cli.js")

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  })
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    exitCode: result.status ?? 1,
  }
}

describe("CLI binary (requires built dist/)", () => {
  it("--help lists all top-level commands", () => {
    const { stdout, exitCode } = runCli(["--help"])
    expect(exitCode).toBe(0)
    const commands = [
      "init",
      "dev",
      "push",
      "diff",
      "pull",
      "generate",
      "migrate",
      "rollback",
      "reset",
      "seed",
      "keys",
      "app",
      "self-host",
      "self-update",
    ]
    for (const cmd of commands) {
      expect(stdout, `Expected '${cmd}' in --help output`).toContain(cmd)
    }
  })

  it("--version prints a semver string", () => {
    const { stdout, exitCode } = runCli(["--version"])
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("self-update --help describes the command", () => {
    const { stdout, exitCode } = runCli(["self-update", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout.toLowerCase()).toMatch(/npm|update/)
  })

  it("init --help describes the init command", () => {
    const { stdout, exitCode } = runCli(["init", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Scaffold")
  })

  it("push --help describes the push command and --yes flag", () => {
    const { stdout, exitCode } = runCli(["push", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("--yes")
    expect(stdout).toContain("--connection")
  })

  it("diff --help describes the diff command", () => {
    const { stdout, exitCode } = runCli(["diff", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("dry run")
  })

  it("pull --help describes deprecated pull command", () => {
    const { stdout, exitCode } = runCli(["pull", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("deprecated")
  })

  it("reset --help shows --yes flag", () => {
    const { stdout, exitCode } = runCli(["reset", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("--yes")
  })

  it("app --help describes the app command with add/remove subcommands", () => {
    const { stdout, exitCode } = runCli(["app", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("add")
    expect(stdout).toContain("remove")
  })

  it("app add --help shows --static and --port options", () => {
    const { stdout, exitCode } = runCli(["app", "add", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("--static")
    expect(stdout).toContain("--port")
  })

  it("self-host --help shows compose only (legacy commands hidden)", () => {
    const { stdout, exitCode } = runCli(["self-host", "--help"])
    expect(exitCode).toBe(0)
    const commandsSection = stdout.split("Commands:")[1] ?? ""
    expect(commandsSection).toContain("compose")
    expect(commandsSection).not.toContain("install-service")
    expect(commandsSection).not.toContain("native")
    expect(commandsSection).not.toContain("backup")
    expect(stdout).not.toContain("--output-dir")
  })

  it("self-host compose --help shows compose subcommands", () => {
    const { stdout, exitCode } = runCli(["self-host", "compose", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("render")
    expect(stdout).toContain("up")
    expect(stdout).toContain("down")
    expect(stdout).toContain("status")
    expect(stdout).toContain("logs")
  })

  it("unknown command exits non-zero", () => {
    const { exitCode } = runCli(["doesnotexist"])
    expect(exitCode).not.toBe(0)
  })
})
