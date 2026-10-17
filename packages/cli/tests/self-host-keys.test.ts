import { describe, it, expect, beforeEach, afterEach } from "vitest"
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
// A JWT_SECRET in the environment wins over the file's, so the runner's own would decide which
// secret the keys are signed with, and whether a test without one in the file mints at all.
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

    const filled = fillMissingKeys(dir)

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

    const filled = fillMissingKeys(dir)

    expect(filled).toEqual(["SERVICE_ROLE_KEY"])
    expect(valueOf("ANON_KEY")).toBe("an-existing-key-in-use")
    expect(valueOf("SERVICE_ROLE_KEY").length).toBeGreaterThan(20)
  })

  it("does nothing when both are already set", () => {
    const before = `JWT_SECRET=${SECRET}\nANON_KEY=key-one\nSERVICE_ROLE_KEY=key-two\n`
    writeFileSync(envPath(), before)

    expect(fillMissingKeys(dir)).toEqual([])
    expect(read()).toBe(before)
  })

  it("treats whitespace as blank, since a stray space is not a key", () => {
    writeFileSync(envPath(), `JWT_SECRET=${SECRET}\nANON_KEY=   \nSERVICE_ROLE_KEY=key-two\n`)

    expect(fillMissingKeys(dir)).toEqual(["ANON_KEY"])
    expect(valueOf("ANON_KEY").length).toBeGreaterThan(20)
  })

  it("does nothing without a secret, rather than minting keys nothing can verify", () => {
    writeFileSync(envPath(), "ANON_KEY=\nSERVICE_ROLE_KEY=\n")

    expect(fillMissingKeys(dir)).toEqual([])
    expect(valueOf("ANON_KEY")).toBe("")
  })

  it("does nothing when there is no .env to write to", () => {
    expect(fillMissingKeys(dir)).toEqual([])
  })
})
