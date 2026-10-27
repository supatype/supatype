/**
 * Tests for `supatype keys`, JWT generation command.
 * Uses subprocess tests (requires built dist/) for the CLI integration,
 * plus direct module tests for the signing logic.
 */
import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isJsonObject, isNumber } from "@supatype/shared"
import { expectShape, parseJsonAs } from "./support/json.js"
import { verifyJwt } from "../src/jwt.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = resolve(__dirname, "../bin/supatype.js")

function runCli(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function decodeJwtPart(part: string): Record<string, unknown> {
  return parseJsonAs(Buffer.from(part, "base64url").toString("utf8"), isJsonObject)
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
    const exp = expectShape(payload["exp"], isNumber)
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it("--exp-years changes the expiry window", () => {
    const short = runCli(["keys", "--secret", SECRET, "--exp-years", "1"])
    const long = runCli(["keys", "--secret", SECRET, "--exp-years", "50"])

    const getExp = (stdout: string): number => {
      const line = stdout.split("\n").find((l) => l.startsWith("ANON_KEY="))!
      const token = line.replace("ANON_KEY=", "").trim()
      return expectShape(parseJwt(token).payload["exp"], isNumber)
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

  it("writes the keys into an existing .env by default, filling blanks", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "st-keys-env-"))
    try {
      writeFileSync(join(tmpDir, ".env"), `JWT_SECRET=${SECRET}\nANON_KEY=\n`, "utf8")
      const { exitCode, stdout } = runCli(["keys"], { cwd: tmpDir, env: { JWT_SECRET: undefined } })
      expect(exitCode).toBe(0)
      expect(stdout).toContain("written to")
      const env = readFileSync(join(tmpDir, ".env"), "utf8")
      const anon = /^ANON_KEY=(.+)$/m.exec(env)?.[1] ?? ""
      expect(verifyJwt(anon, SECRET)).not.toBeNull()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("only prints under --print, leaving .env alone", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "st-keys-env-"))
    try {
      writeFileSync(join(tmpDir, ".env"), `JWT_SECRET=${SECRET}\n`, "utf8")
      const { exitCode, stdout } = runCli(["keys", "--print"], { cwd: tmpDir, env: { JWT_SECRET: undefined } })
      expect(exitCode).toBe(0)
      expect(stdout).toContain("ANON_KEY=")
      expect(readFileSync(join(tmpDir, ".env"), "utf8")).toBe(`JWT_SECRET=${SECRET}\n`)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("still accepts --write, which 0.7.0's docs use", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "st-keys-env-"))
    try {
      writeFileSync(join(tmpDir, ".env"), `JWT_SECRET=${SECRET}\n`, "utf8")
      const { exitCode } = runCli(["keys", "--write"], { cwd: tmpDir, env: { JWT_SECRET: undefined } })
      expect(exitCode).toBe(0)
      expect(readFileSync(join(tmpDir, ".env"), "utf8")).toMatch(/^SERVICE_ROLE_KEY=ey/m)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("generates a JWT_SECRET into a .env that has none, and signs with it", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "st-keys-nosecret-"))
    try {
      writeFileSync(join(tmpDir, ".env"), "ANON_KEY=\n", "utf8")
      const { exitCode } = runCli(["keys"], { cwd: tmpDir, env: { JWT_SECRET: undefined } })
      expect(exitCode).toBe(0)
      const env = readFileSync(join(tmpDir, ".env"), "utf8")
      const secret = /^JWT_SECRET=(.+)$/m.exec(env)?.[1] ?? ""
      expect(secret.length).toBeGreaterThanOrEqual(32)
      expect(verifyJwt(/^ANON_KEY=(.+)$/m.exec(env)?.[1] ?? "", secret)).not.toBeNull()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("with no .env and no secret, prints a generated secret with keys signed by it", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "st-keys-nosecret-"))
    try {
      const { exitCode, stdout } = runCli(["keys"], { cwd: tmpDir, env: { JWT_SECRET: undefined } })
      expect(exitCode).toBe(0)
      const secret = /^JWT_SECRET=(.+)$/m.exec(stdout)?.[1] ?? ""
      const anon = /^ANON_KEY=(.+)$/m.exec(stdout)?.[1] ?? ""
      expect(verifyJwt(anon, secret)).not.toBeNull()
      expect(stdout).toContain("Create a .env")
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("keys --help shows --secret and --exp-years options", () => {
    const { stdout, exitCode } = runCli(["keys", "--help"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("--secret")
    expect(stdout).toContain("--exp-years")
    expect(stdout).toContain("--print")
    expect(stdout).toContain("--write")
  })
})
