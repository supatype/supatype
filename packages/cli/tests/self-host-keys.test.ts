import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fillMissingKeys } from "../src/commands/keys.js"
import { verifyJwt } from "../src/jwt.js"

/**
 * A self-host `.env` copied from the template arrives with ANON_KEY and
 * SERVICE_ROLE_KEY blank, and the server refuses to serve without a service
 * role key outside dev mode. The documented quick start could not start.
 *
 * Filling them has to be conservative: an operator's existing key must never be
 * reissued, because every client holding the old one would stop working.
 */
const SECRET = "a-local-development-secret-at-least-32-chars"

let dir: string
// A JWT_SECRET in the environment is refused when it differs from the file's and written when the
// file has none, so the runner's own would decide what these tests see.
const savedSecret = process.env["JWT_SECRET"]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "selfhost-keys-"))
  delete process.env["JWT_SECRET"]
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (savedSecret === undefined) delete process.env["JWT_SECRET"]
  else process.env["JWT_SECRET"] = savedSecret
})

const envPath = () => join(dir, ".env")
const read = () => readFileSync(envPath(), "utf8")
const valueOf = (name: string): string => {
  const line = read().split(/\r?\n/).find((l) => l.startsWith(`${name}=`))
  return line === undefined ? "" : line.slice(name.length + 1)
}

describe("filling the self-host keys", () => {
  it("mints both when the template leaves them blank", () => {
    writeFileSync(envPath(), `JWT_SECRET=${SECRET}\nANON_KEY=\nSERVICE_ROLE_KEY=\n`)

    const { filled } = fillMissingKeys(dir)

    expect(filled.sort()).toEqual(["ANON_KEY", "SERVICE_ROLE_KEY"])
    expect(valueOf("ANON_KEY").length).toBeGreaterThan(20)
    expect(valueOf("SERVICE_ROLE_KEY").length).toBeGreaterThan(20)
  })

  it("signs them with the secret in the file, so they verify against it", () => {
    writeFileSync(envPath(), `JWT_SECRET=${SECRET}\nANON_KEY=\nSERVICE_ROLE_KEY=\n`)
    fillMissingKeys(dir)

    // Checked against the signature, not only decoded: a key signed with anything but the file's
    // secret is one the server refuses.
    const claims = (name: string): Record<string, unknown> => {
      const verified = verifyJwt(valueOf(name), SECRET)
      if (verified === null) throw new Error(`${name} does not verify against the file's JWT_SECRET`)
      return verified
    }

    expect(claims("ANON_KEY")["role"]).toBe("anon")
    expect(claims("SERVICE_ROLE_KEY")["role"]).toBe("service_role")
  })

  it("leaves a key the operator already set alone", () => {
    writeFileSync(
      envPath(),
      `JWT_SECRET=${SECRET}\nANON_KEY=an-existing-key-in-use\nSERVICE_ROLE_KEY=\n`,
    )

    const { filled } = fillMissingKeys(dir)

    expect(filled).toEqual(["SERVICE_ROLE_KEY"])
    expect(valueOf("ANON_KEY")).toBe("an-existing-key-in-use")
    expect(valueOf("SERVICE_ROLE_KEY").length).toBeGreaterThan(20)
  })

  it("does nothing when both are already set", () => {
    const before = `JWT_SECRET=${SECRET}\nANON_KEY=key-one\nSERVICE_ROLE_KEY=key-two\n`
    writeFileSync(envPath(), before)

    expect(fillMissingKeys(dir).filled).toEqual([])
    expect(read()).toBe(before)
  })

  it("treats whitespace as blank, since a stray space is not a key", () => {
    writeFileSync(envPath(), `JWT_SECRET=${SECRET}\nANON_KEY=   \nSERVICE_ROLE_KEY=key-two\n`)

    expect(fillMissingKeys(dir).filled).toEqual(["ANON_KEY"])
    expect(valueOf("ANON_KEY").length).toBeGreaterThan(20)
  })

  it("does nothing when there is no .env to write to", () => {
    expect(fillMissingKeys(dir).filled).toEqual([])
  })
})

/**
 * Compose reads JWT_SECRET from the shell ahead of `.env`, and `.env` is what every later run reads.
 * Keys minted with a shell secret `.env` does not hold verify on this run and fail on the next one,
 * so the secret they are signed with is `.env`'s, a different shell one is refused, and a `.env`
 * without one gets the secret the keys were signed with.
 */
describe("the secret self-host compose up mints the keys with", () => {
  const OTHER = "a-different-secret-that-is-also-32-chars"
  let said: string[] = []
  beforeEach(() => {
    said = []
    const capture = (...args: unknown[]): void => void said.push(args.map(String).join(" "))
    vi.spyOn(console, "log").mockImplementation(capture)
    vi.spyOn(console, "error").mockImplementation(capture)
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`exit ${String(code)}`)
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it("refuses a shell JWT_SECRET that differs from .env's, writes nothing, and says how to fix it", () => {
    const before = `JWT_SECRET=${SECRET}\nANON_KEY=\nSERVICE_ROLE_KEY=\n`
    writeFileSync(envPath(), before)
    process.env["JWT_SECRET"] = OTHER

    expect(() => fillMissingKeys(dir)).toThrow("exit 1")
    expect(read()).toBe(before)
    const out = said.join("\n")
    expect(out).toContain("JWT_SECRET environment variable")
    expect(out).toContain("unset JWT_SECRET")
    expect(out).toContain("supatype keys --force")
  })

  it("writes a shell JWT_SECRET into a .env that has none, beside keys signed with it", () => {
    writeFileSync(envPath(), "ANON_KEY=\nSERVICE_ROLE_KEY=\n")
    process.env["JWT_SECRET"] = OTHER

    fillMissingKeys(dir)

    expect(valueOf("JWT_SECRET")).toBe(OTHER)
    expect(verifyJwt(valueOf("ANON_KEY"), OTHER)).not.toBeNull()
    expect(verifyJwt(valueOf("SERVICE_ROLE_KEY"), OTHER)).not.toBeNull()
  })

  it("generates a JWT_SECRET into a .env that has none, and signs the keys with it", () => {
    writeFileSync(envPath(), "ANON_KEY=\nSERVICE_ROLE_KEY=\n")

    fillMissingKeys(dir)

    const secret = valueOf("JWT_SECRET")
    expect(secret.length).toBeGreaterThanOrEqual(32)
    expect(verifyJwt(valueOf("ANON_KEY"), secret)).not.toBeNull()
  })
})
