/**
 * Subprocess tests — spawn the compiled CLI binary and verify commands are
 * registered. Requires `pnpm build` to have run first (turbo handles this).
 */
import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = resolve(__dirname, "../bin/definatype.js")
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
    const commands = ["init", "dev", "push", "diff", "pull", "generate", "migrate", "rollback", "reset", "seed", "keys", "app", "self-host"]
    for (const cmd of commands) {
      expect(stdout, `Expected '${cmd}' in --help output`).toContain(cmd)
    }
  })

  it("--version prints a semver string", () => {
    const { stdout, exitCode } = runCli(["--version"])
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
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

  it("pull --help shows --output option", () => {
    const { stdout, exitCode } = runCli(["pull", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("--output")
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

  it("app add --help shows --dockerfile and --port options", () => {
    const { stdout, exitCode } = runCli(["app", "add", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("--dockerfile")
    expect(stdout).toContain("--port")
  })

  it("self-host --help describes the self-host command", () => {
    const { stdout, exitCode } = runCli(["self-host", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("setup")
    expect(stdout).toContain("status")
    expect(stdout).toContain("logs")
    expect(stdout).toContain("backup")
    expect(stdout).toContain("update")
  })

  it("self-host setup --help shows --domain option", () => {
    const { stdout, exitCode } = runCli(["self-host", "setup", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("--domain")
  })

  it("unknown command exits non-zero", () => {
    const { exitCode } = runCli(["doesnotexist"])
    expect(exitCode).not.toBe(0)
  })
})
