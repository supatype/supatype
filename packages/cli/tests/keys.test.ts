/**
 * Tests for `supatype keys`, JWT generation command.
 * Uses subprocess tests (requires built dist/) for the CLI integration,
 * plus direct module tests for the signing logic.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { delimiter, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
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

  describe("the secret the keys written into .env are signed with", () => {
    const OTHER = "a-different-secret-that-is-also-32-chars"
    let tmpDir = ""
    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "st-keys-source-"))
    })
    afterEach(() => rmSync(tmpDir, { recursive: true, force: true }))

    const envFile = (): string => readFileSync(join(tmpDir, ".env"), "utf8")
    const envValue = (key: string): string => new RegExp(`^${key}=(.+)$`, "m").exec(envFile())?.[1] ?? ""

    it("refuses when --secret disagrees with .env's JWT_SECRET, and writes nothing", () => {
      const before = `JWT_SECRET=${SECRET}\nANON_KEY=\n`
      writeFileSync(join(tmpDir, ".env"), before, "utf8")
      const { exitCode, stdout, stderr } = runCli(["keys", "--secret", OTHER], {
        cwd: tmpDir,
        env: { JWT_SECRET: undefined },
      })
      expect(exitCode).toBe(1)
      const said = stdout + stderr
      expect(said).toContain("--secret")
      expect(said).toContain("--print")
      expect(envFile()).toBe(before)
    })

    it("signs with .env's JWT_SECRET when the shell's differs, and says so once", () => {
      writeFileSync(join(tmpDir, ".env"), `JWT_SECRET=${SECRET}\nANON_KEY=\n`, "utf8")
      const { exitCode, stdout, stderr } = runCli(["keys"], { cwd: tmpDir, env: { JWT_SECRET: OTHER } })
      expect(exitCode).toBe(0)
      expect((stdout + stderr).match(/uses the one in \.env/g)).toHaveLength(1)
      expect(envValue("JWT_SECRET")).toBe(SECRET)
      expect(verifyJwt(envValue("ANON_KEY"), SECRET)).not.toBeNull()
    })

    it("re-signs both keys when it writes a new JWT_SECRET, since the old ones cannot verify", () => {
      writeFileSync(join(tmpDir, ".env"), "ANON_KEY=old-anon\nSERVICE_ROLE_KEY=old-service\n", "utf8")
      const { exitCode } = runCli(["keys"], { cwd: tmpDir, env: { JWT_SECRET: undefined } })
      expect(exitCode).toBe(0)
      const secret = envValue("JWT_SECRET")
      expect(verifyJwt(envValue("ANON_KEY"), secret)).not.toBeNull()
      expect(verifyJwt(envValue("SERVICE_ROLE_KEY"), secret)).not.toBeNull()
    })

    it.each([
      ["a short --secret", "ANON_KEY=\n", ["--secret", "twenty-chars-secret!"]],
      ["a --secret with a space", "ANON_KEY=\n", ["--secret", "a secret long enough to use, with spaces"]],
      ["a short JWT_SECRET in .env", "JWT_SECRET=twenty-chars-secret!\nANON_KEY=\n", []],
    ])("refuses %s before writing anything", (_case, before, args) => {
      writeFileSync(join(tmpDir, ".env"), before, "utf8")
      const { exitCode } = runCli(["keys", ...args], { cwd: tmpDir, env: { JWT_SECRET: undefined } })
      expect(exitCode).toBe(1)
      expect(envFile()).toBe(before)
    })

    it("signs with .env's JWT_SECRET when --secret agrees with it", () => {
      writeFileSync(join(tmpDir, ".env"), `JWT_SECRET=${SECRET}\n`, "utf8")
      const { exitCode } = runCli(["keys", "--secret", SECRET], { cwd: tmpDir, env: { JWT_SECRET: undefined } })
      expect(exitCode).toBe(0)
      expect(verifyJwt(envValue("ANON_KEY"), SECRET)).not.toBeNull()
    })

    it.each([
      ["--secret", ["--secret", OTHER], {}],
      ["the JWT_SECRET environment variable", [], { JWT_SECRET: OTHER }],
    ])("writes %s into a .env that has no JWT_SECRET, beside keys signed with it", (_source, args, env) => {
      writeFileSync(join(tmpDir, ".env"), "ANON_KEY=\n", "utf8")
      const { exitCode } = runCli(["keys", ...args], { cwd: tmpDir, env: { JWT_SECRET: undefined, ...env } })
      expect(exitCode).toBe(0)
      expect(envValue("JWT_SECRET")).toBe(OTHER)
      expect(verifyJwt(envValue("ANON_KEY"), OTHER)).not.toBeNull()
      expect(verifyJwt(envValue("SERVICE_ROLE_KEY"), OTHER)).not.toBeNull()
    })

    it("--print invents no secret when there is none to sign with", () => {
      writeFileSync(join(tmpDir, ".env"), "ANON_KEY=\n", "utf8")
      const { exitCode, stdout, stderr } = runCli(["keys", "--print"], {
        cwd: tmpDir,
        env: { JWT_SECRET: undefined },
      })
      expect(exitCode).toBe(1)
      const said = stdout + stderr
      expect(said).toContain("No JWT_SECRET")
      expect(said).toContain("`supatype keys`")
      expect(said).not.toMatch(/^(JWT_SECRET|ANON_KEY)=/m)
      expect(envFile()).toBe("ANON_KEY=\n")
    })

    it.each([
      ["a short --secret", ["--secret", "short123"], "", "--secret is 8 characters"],
      ["a short secret in .env", [], "JWT_SECRET=short123\n", "JWT_SECRET in .env is 8 characters"],
      [
        "a --secret .env cannot hold unquoted",
        ["--secret", "a secret long enough to use but with spaces"],
        "",
        "--secret contains whitespace",
      ],
    ])("--print refuses to sign with %s", (_, args, env, why) => {
      writeFileSync(join(tmpDir, ".env"), env, "utf8")
      const { exitCode, stdout, stderr } = runCli(["keys", "--print", ...args], {
        cwd: tmpDir,
        env: { JWT_SECRET: undefined },
      })
      expect(exitCode).toBe(1)
      expect(stdout + stderr).toContain(why)
      expect(stdout).not.toMatch(/^ANON_KEY=/m)
    })
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

describe("supatype init with a shell JWT_SECRET it cannot use", () => {
  // It said so when it generated one instead, and again as "differs from the JWT_SECRET in .env"
  // when it signed the keys with the one it generated.
  it("says so once", () => {
    const parent = mkdtempSync(join(tmpdir(), "st-init-shell-secret-"))
    try {
      const { exitCode, stdout, stderr } = runCli(["init", "acme", "-y", "--no-install"], {
        cwd: parent,
        env: { ...initWithoutDockerOrNetwork(), JWT_SECRET: "short" },
      })
      expect(exitCode).toBe(0)
      expect((stdout + stderr).match(/JWT_SECRET environment variable/g)).toHaveLength(1)
    } finally {
      // Retried: on Windows a process init started can still hold the directory for a moment
      // after the CLI exits, and the cleanup then failed the test with EBUSY under a loaded suite.
      rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})

/**
 * What `init -y` asks of the machine, answered at once. It asked Docker which ports other stacks
 * hold (`docker ps`, `docker inspect`), whether the daemon runs (`docker version`, `docker info`)
 * and the npm registry for package versions: measured at 8 to 14 seconds a Docker call in a loaded
 * suite, which timed the test out while it passed alone in 5. None of it is what the test checks.
 * The shell's Kong port is taken as given, the registry is one that refuses at once (the versions
 * fall back to the CLI's own), and with no Docker on PATH the daemon check ends at the first call.
 */
function initWithoutDockerOrNetwork(): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH"
  const withoutDocker = (process.env[pathKey] ?? "")
    .split(delimiter)
    .filter((dir) => !["docker", "docker.exe"].some((bin) => existsSync(join(dir, bin))))
    .join(delimiter)
  return { [pathKey]: withoutDocker, SUPATYPE_KONG_PORT: "18999", npm_config_registry: "http://127.0.0.1:1" }
}
