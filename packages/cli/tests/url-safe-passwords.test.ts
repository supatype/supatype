import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { dockerDbUrl, dockerPgLoopbackDbUrl } from "../src/docker-postgres.js"
import { devDatabaseUrl, generateJwtSecret } from "../src/local-secrets.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { composePasswordProblems, warnUrlUnsafeComposePasswords } from "../src/url-safe-passwords.js"

const warned = vi.hoisted(() => vi.fn<(message: string) => void>())
vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  warn: warned,
}))

/**
 * A database password goes into a connection URL, where `@`, `:`, `/`, `#` and `%` are syntax.
 * The CLI built some of its URLs without encoding, so a password with any of them produced a URL
 * that named a different host, or none. The compose file cannot encode at all: the password there
 * is a `${VAR}` compose fills in at up-time, so the only safe answer is to refuse such a value.
 */
const AWKWARD = "p@ss:w/rd?x%y"

function passwordOf(url: string): string {
  return decodeURIComponent(new URL(url).password)
}

describe("connection URLs the CLI builds", () => {
  it("encode the password in the docker container URL", () => {
    const url = dockerDbUrl("acme", 54329, AWKWARD)
    expect(new URL(url).hostname).toBe("127.0.0.1")
    expect(passwordOf(url)).toBe(AWKWARD)
  })

  it("encode the password in the loopback URL", () => {
    expect(passwordOf(dockerPgLoopbackDbUrl("acme", AWKWARD))).toBe(AWKWARD)
  })

  it("encode the password in the dev database URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-url-"))
    try {
      writeFileSync(join(dir, ".env"), `POSTGRES_PASSWORD=${AWKWARD}\n`)
      const url = devDatabaseUrl(dir, "127.0.0.1:54329")
      expect(new URL(url).port).toBe("54329")
      expect(passwordOf(url)).toBe(AWKWARD)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("composePasswordProblems", () => {
  const env = (extra: Record<string, string>): Record<string, string> => ({
    POSTGRES_PASSWORD: "abc",
    AUTHENTICATOR_PASSWORD: "def",
    SUPATYPE_SQL_EDITOR_PASSWORD: "ghi",
    ...extra,
  })

  it("accepts what init and the CLI generate", () => {
    const generated = generateJwtSecret()
    expect(composePasswordProblems(env({ POSTGRES_PASSWORD: generated }), false)).toEqual([])
  })

  it("names each variable whose value would break the URL, and the character", () => {
    const problems = composePasswordProblems(
      env({ POSTGRES_PASSWORD: "a@b", SUPATYPE_SQL_EDITOR_PASSWORD: "x/y" }),
      false,
    )
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain("POSTGRES_PASSWORD")
    expect(problems[0]).toContain('"@"')
    expect(problems[1]).toContain("SUPATYPE_SQL_EDITOR_PASSWORD")
  })

  it.each([":", "/", "?", "#", "%", "[", " "])("refuses %j", (char) => {
    expect(composePasswordProblems(env({ AUTHENTICATOR_PASSWORD: `a${char}b` }), false)).toHaveLength(1)
  })

  it("ignores POSTGRES_PASSWORD with an external database, whose URL is the operator's", () => {
    expect(composePasswordProblems(env({ POSTGRES_PASSWORD: "a@b" }), true)).toEqual([])
  })
})

describe("warnUrlUnsafeComposePasswords", () => {
  // push, diff and dev's recovery start only the database, so they warn where up and dev refuse.
  const config: SupatypeProjectConfig = {
    project: { name: "acme" },
    database: { provider: "docker" },
    server: { mode: "dev" },
    app: { mode: "none" },
  }

  function warningsFor(envText: string): string[] {
    const dir = mkdtempSync(join(tmpdir(), "supatype-url-warn-"))
    warned.mockClear()
    try {
      writeFileSync(join(dir, ".env"), envText)
      warnUrlUnsafeComposePasswords(dir, config)
      return warned.mock.calls.map(([message]) => message)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("names the password and the fix, and carries on", () => {
    const said = warningsFor("POSTGRES_PASSWORD=a@b\n")
    expect(said[0]).toContain('POSTGRES_PASSWORD in .env contains "@"')
    expect(said.join("\n")).toContain("openssl rand -hex 24")
  })

  it("says nothing when every password is URL-safe", () => {
    expect(warningsFor("POSTGRES_PASSWORD=abc\n")).toEqual([])
  })
})
