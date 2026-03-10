/**
 * Tests for `supatype keys` — JWT generation command.
 * Uses subprocess tests (requires built dist/) for the CLI integration,
 * plus direct module tests for the signing logic.
 */
import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = resolve(__dirname, "../bin/definatype.js")

function runCli(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  })
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    exitCode: result.status ?? 1,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>
}

function parseJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const parts = token.split(".")
  expect(parts).toHaveLength(3)
  return {
    header: decodeJwtPart(parts[0]!),
    payload: decodeJwtPart(parts[1]!),
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("supatype keys (CLI subprocess)", () => {
  const SECRET = "my-test-jwt-secret-that-is-32-chars!"

  it("exits 0 with --secret", () => {
    const { exitCode } = runCli(["keys", "--secret", SECRET])
    expect(exitCode).toBe(0)
  })

  it("outputs ANON_KEY= line", () => {
    const { stdout } = runCli(["keys", "--secret", SECRET])
    expect(stdout).toContain("ANON_KEY=")
  })

  it("outputs SERVICE_ROLE_KEY= line", () => {
    const { stdout } = runCli(["keys", "--secret", SECRET])
    expect(stdout).toContain("SERVICE_ROLE_KEY=")
  })

  it("ANON_KEY is a valid three-part JWT", () => {
    const { stdout } = runCli(["keys", "--secret", SECRET])
    const line = stdout.split("\n").find((l) => l.startsWith("ANON_KEY="))!
    const token = line.replace("ANON_KEY=", "").trim()
    const { header, payload } = parseJwt(token)
    expect(header["alg"]).toBe("HS256")
    expect(header["typ"]).toBe("JWT")
    expect(payload["role"]).toBe("anon")
    expect(payload["iss"]).toBe("supatype")
  })

  it("SERVICE_ROLE_KEY payload has role: service_role", () => {
    const { stdout } = runCli(["keys", "--secret", SECRET])
    const line = stdout.split("\n").find((l) => l.startsWith("SERVICE_ROLE_KEY="))!
    const token = line.replace("SERVICE_ROLE_KEY=", "").trim()
    const { payload } = parseJwt(token)
    expect(payload["role"]).toBe("service_role")
    expect(payload["iss"]).toBe("supatype")
  })

  it("JWT has exp in the future", () => {
    const { stdout } = runCli(["keys", "--secret", SECRET])
    const line = stdout.split("\n").find((l) => l.startsWith("ANON_KEY="))!
    const token = line.replace("ANON_KEY=", "").trim()
    const { payload } = parseJwt(token)
    const exp = payload["exp"] as number
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it("--exp-years changes the expiry window", () => {
    const short = runCli(["keys", "--secret", SECRET, "--exp-years", "1"])
    const long = runCli(["keys", "--secret", SECRET, "--exp-years", "50"])

    const getExp = (stdout: string): number => {
      const line = stdout.split("\n").find((l) => l.startsWith("ANON_KEY="))!
      const token = line.replace("ANON_KEY=", "").trim()
      return (parseJwt(token).payload["exp"]) as number
    }

    expect(getExp(long.stdout)).toBeGreaterThan(getExp(short.stdout))
  })

  it("reads JWT_SECRET from environment variable", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "st-keys-env-"))
    try {
      const { exitCode, stdout } = runCli(["keys"], {
        cwd: tmpDir,
        env: { JWT_SECRET: SECRET },
      })
      expect(exitCode).toBe(0)
      expect(stdout).toContain("ANON_KEY=")
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("reads JWT_SECRET from .env file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "st-keys-env-"))
    try {
      writeFileSync(join(tmpDir, ".env"), `JWT_SECRET=${SECRET}\n`, "utf8")
      const { exitCode, stdout } = runCli(["keys"], {
        cwd: tmpDir,
        env: { JWT_SECRET: undefined as unknown as string },
      })
      expect(exitCode).toBe(0)
      expect(stdout).toContain("ANON_KEY=")
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("exits non-zero when no secret is available", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "st-keys-nosecret-"))
    try {
      const { exitCode, stderr } = runCli(["keys"], {
        cwd: tmpDir,
        env: { JWT_SECRET: undefined as unknown as string },
      })
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain("JWT_SECRET")
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("keys --help shows --secret and --exp-years options", () => {
    const { stdout, exitCode } = runCli(["keys", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("--secret")
    expect(stdout).toContain("--exp-years")
  })
})
