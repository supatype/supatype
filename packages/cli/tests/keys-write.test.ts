/**
 * `supatype keys --write` writes the pair it mints.
 *
 * The command printed the keys and wrote nothing, while every README in this repository says it
 * mints them into `.env`. Following the docs therefore produced a front end built with
 * `anonKey: undefined` and a gateway refusing its every request, with nothing in the output saying
 * so.
 *
 * Writing is opt-in rather than the default: a command that reads a secret and edits a file on
 * sight is worse than one that has to be asked. What it writes is blanks only, because an anon key
 * already in `.env` is held by clients this command cannot reach and reissuing it locks them out.
 * `--force` is how someone says they meant to rotate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { anonKeyEnvUpdates, writeKeysToEnv } from "../src/commands/keys.js"

const PAIR = { anonKey: "anon.jwt.value", serviceKey: "service.jwt.value" }

function envValue(dir: string, key: string): string | undefined {
  const line = readFileSync(join(dir, ".env"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`))
  return line?.slice(key.length + 1).trim()
}

describe("writeKeysToEnv", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-keys-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("fills blank keys", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=s\nANON_KEY=\nSERVICE_ROLE_KEY=\n")
    const result = writeKeysToEnv(dir, PAIR, false)

    expect(result.written).toContain("ANON_KEY")
    expect(result.written).toContain("SERVICE_ROLE_KEY")
    expect(envValue(dir, "ANON_KEY")).toBe(PAIR.anonKey)
    expect(envValue(dir, "SERVICE_ROLE_KEY")).toBe(PAIR.serviceKey)
  })

  it("adds keys that are absent entirely", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=s\n")
    writeKeysToEnv(dir, PAIR, false)

    expect(envValue(dir, "ANON_KEY")).toBe(PAIR.anonKey)
    expect(envValue(dir, "VITE_SUPATYPE_ANON_KEY")).toBe(PAIR.anonKey)
  })

  it("treats a declared-but-blank line as a blank to fill", () => {
    // The templates ship `ANON_KEY=` with nothing after it, which is exactly the line to write.
    writeFileSync(join(dir, ".env"), "JWT_SECRET=s\nVITE_SUPATYPE_ANON_KEY=\n")
    const result = writeKeysToEnv(dir, PAIR, false)

    expect(result.written).toContain("VITE_SUPATYPE_ANON_KEY")
    expect(envValue(dir, "VITE_SUPATYPE_ANON_KEY")).toBe(PAIR.anonKey)
  })

  it("leaves a key that already holds a value, and says which", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=s\nANON_KEY=in-use-by-clients\nSERVICE_ROLE_KEY=\n")
    const result = writeKeysToEnv(dir, PAIR, false)

    expect(result.kept).toContain("ANON_KEY")
    expect(result.written).not.toContain("ANON_KEY")
    expect(envValue(dir, "ANON_KEY")).toBe("in-use-by-clients")
    expect(envValue(dir, "SERVICE_ROLE_KEY")).toBe(PAIR.serviceKey)
  })

  it("replaces every key it owns under --force, not only the blank ones", () => {
    writeFileSync(
      join(dir, ".env"),
      "JWT_SECRET=s\nANON_KEY=old-anon\nSERVICE_ROLE_KEY=old-service\nVITE_SUPATYPE_ANON_KEY=old-vite\n",
    )
    const result = writeKeysToEnv(dir, PAIR, true)

    expect(result.kept).toEqual([])
    expect(envValue(dir, "ANON_KEY")).toBe(PAIR.anonKey)
    expect(envValue(dir, "SERVICE_ROLE_KEY")).toBe(PAIR.serviceKey)
    expect(envValue(dir, "VITE_SUPATYPE_ANON_KEY")).toBe(PAIR.anonKey)
  })

  it("does not rewrite the file, even under --force", () => {
    // `.env` holds JWT_SECRET, which these keys are derived from, plus the database password and
    // whatever else the project keeps there. Replacing the file would leave a project whose keys
    // cannot be regenerated and whose stack cannot start.
    writeFileSync(
      join(dir, ".env"),
      "# a comment someone wrote\nJWT_SECRET=s\nPOSTGRES_PASSWORD=pw\nANON_KEY=old\nCUSTOM_THING=mine\n",
    )
    writeKeysToEnv(dir, PAIR, true)

    const content = readFileSync(join(dir, ".env"), "utf8")
    expect(content).toContain("# a comment someone wrote")
    expect(envValue(dir, "JWT_SECRET")).toBe("s")
    expect(envValue(dir, "POSTGRES_PASSWORD")).toBe("pw")
    expect(envValue(dir, "CUSTOM_THING")).toBe("mine")
  })

  it("carries the API URL through when the project records one", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=s\nPUBLIC_SUPATYPE_URL=http://localhost:18475\n")
    writeKeysToEnv(dir, PAIR, true)

    expect(envValue(dir, "VITE_SUPATYPE_URL")).toBe("http://localhost:18475")
  })

  it("writes no URL names when the project records no URL", () => {
    // An empty `VITE_SUPATYPE_URL` is worse than an absent one: the client reads it, finds a blank
    // string, and requests against the page origin without saying why.
    writeFileSync(join(dir, ".env"), "JWT_SECRET=s\n")
    writeKeysToEnv(dir, PAIR, false)

    expect(readFileSync(join(dir, ".env"), "utf8")).not.toContain("VITE_SUPATYPE_URL")
  })

  it("reports no .env rather than creating one", () => {
    const result = writeKeysToEnv(dir, PAIR, false)

    expect(result.path).toBeNull()
    expect(result.written).toEqual([])
  })
})

describe("anonKeyEnvUpdates", () => {
  it("is the one list both `keys` and `dev` write from", () => {
    // They held separate lists, so a front end's prefix could be written by one and forgotten by
    // the other, and which names a project's .env ended up with depended on which command ran last.
    const names = Object.keys(anonKeyEnvUpdates("a", "s"))
    expect(names).toEqual([
      "ANON_KEY",
      "SERVICE_ROLE_KEY",
      "VITE_SUPATYPE_ANON_KEY",
      "PUBLIC_SUPATYPE_ANON_KEY",
      "EXPO_PUBLIC_SUPATYPE_ANON_KEY",
    ])
  })

  it("adds the URL names only when given a URL", () => {
    expect(Object.keys(anonKeyEnvUpdates("a", "s", "http://x"))).toContain("VITE_SUPATYPE_URL")
    expect(Object.keys(anonKeyEnvUpdates("a", "s"))).not.toContain("VITE_SUPATYPE_URL")
  })
})
