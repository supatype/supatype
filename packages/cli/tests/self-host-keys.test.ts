import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fillMissingKeys } from "../src/commands/keys.js"

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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "selfhost-keys-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
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

    const claims = (jwt: string): Record<string, unknown> =>
      JSON.parse(Buffer.from(jwt.split(".")[1] as string, "base64url").toString("utf8"))

    expect(claims(valueOf("ANON_KEY")).role).toBe("anon")
    expect(claims(valueOf("SERVICE_ROLE_KEY")).role).toBe("service_role")
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
