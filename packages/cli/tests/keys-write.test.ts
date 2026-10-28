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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { anonKeyEnvUpdates, generateAndWriteKeys, writeKeysToEnv } from "../src/commands/keys.js"
import { readEnvFile } from "../src/env-file.js"
import { verifyJwt } from "../src/jwt.js"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"

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
      "NEXT_PUBLIC_SUPATYPE_ANON_KEY",
    ])
  })

  it("adds the URL names only when given a URL", () => {
    expect(Object.keys(anonKeyEnvUpdates("a", "s", "http://x"))).toContain("VITE_SUPATYPE_URL")
    expect(Object.keys(anonKeyEnvUpdates("a", "s"))).not.toContain("VITE_SUPATYPE_URL")
    expect(Object.keys(anonKeyEnvUpdates("a", "s", "http://x"))).toContain("NEXT_PUBLIC_SUPATYPE_URL")
    expect(Object.keys(anonKeyEnvUpdates("a", "s"))).not.toContain("NEXT_PUBLIC_SUPATYPE_URL")
  })
})

describe("reading JWT_SECRET for keys", () => {
  let dir: string
  const savedSecret = process.env["JWT_SECRET"]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-keys-secret-"))
    delete process.env["JWT_SECRET"]
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (savedSecret === undefined) delete process.env["JWT_SECRET"]
    else process.env["JWT_SECRET"] = savedSecret
  })

  it("leaves an inline comment out of the secret, as compose does", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=the-real-secret-of-at-least-32-chars  # rotated in May\n")
    expect(readEnvFile(dir)["JWT_SECRET"]).toBe("the-real-secret-of-at-least-32-chars")
  })

  it("reads the last JWT_SECRET when the key is assigned twice", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=old-one\nJWT_SECRET=new-one\n")
    expect(readEnvFile(dir)["JWT_SECRET"]).toBe("new-one")
  })
})

describe("generateAndWriteKeys (init)", () => {
  let dir: string
  const SECRET = "a-local-development-secret-at-least-32-chars"
  const savedSecret = process.env["JWT_SECRET"]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-keys-init-"))
    delete process.env["JWT_SECRET"]
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (savedSecret === undefined) delete process.env["JWT_SECRET"]
    else process.env["JWT_SECRET"] = savedSecret
  })

  it("writes the Next.js names with the rest, and keys that verify against the secret", () => {
    writeFileSync(join(dir, ".env"), `JWT_SECRET=${SECRET}  # note\nPUBLIC_SUPATYPE_URL=http://localhost:18999\n`)
    const result = generateAndWriteKeys(dir)
    if (!result.ok) throw new Error(result.reason)

    expect(envValue(dir, "NEXT_PUBLIC_SUPATYPE_ANON_KEY")).toBe(result.anonKey)
    expect(envValue(dir, "NEXT_PUBLIC_SUPATYPE_URL")).toBe("http://localhost:18999")
    expect(verifyJwt(envValue(dir, "ANON_KEY") ?? "", SECRET)).not.toBeNull()
  })
})

/**
 * `init` writes a new `.env` and then signs keys into it. A JWT_SECRET exported in the shell used
 * to sign the keys while `.env` got a generated secret, so the keys failed against the stack as soon
 * as it ran from a shell without that variable.
 */
describe("the secret init signs its keys with", () => {
  const OTHER = "a-different-secret-that-is-also-32-chars"
  let dir: string
  const savedSecret = process.env["JWT_SECRET"]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-keys-init-shell-"))
    process.env["JWT_SECRET"] = OTHER
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`exit ${String(code)}`)
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
    if (savedSecret === undefined) delete process.env["JWT_SECRET"]
    else process.env["JWT_SECRET"] = savedSecret
  })

  it("is the one the new .env holds, which is the shell's when one is exported", () => {
    scaffold(dir, defaultScaffoldOptions("acme"))
    generateAndWriteKeys(dir)

    const secret = envValue(dir, "JWT_SECRET") ?? ""
    expect(secret).toBe(OTHER)
    expect(verifyJwt(envValue(dir, "ANON_KEY") ?? "", secret)).not.toBeNull()
  })

  it("signs with .env's JWT_SECRET when the shell's differs, and never exits mid-init", () => {
    const inFile = "a-local-development-secret-at-least-32-chars"
    writeFileSync(join(dir, ".env"), `JWT_SECRET=${inFile}\nANON_KEY=\n`)

    const result = generateAndWriteKeys(dir)

    expect(result.ok).toBe(true)
    expect(envValue(dir, "JWT_SECRET")).toBe(inFile)
    expect(verifyJwt(envValue(dir, "ANON_KEY") ?? "", inFile)).not.toBeNull()
  })

  it("comes back with the reason rather than exiting when .env's JWT_SECRET is too short", () => {
    const before = "JWT_SECRET=twenty-chars-secret!\nANON_KEY=\n"
    writeFileSync(join(dir, ".env"), before)

    const result = generateAndWriteKeys(dir)

    expect(result.ok).toBe(false)
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before)
  })

  it.each([
    ["too short", "twenty-chars-secret!"],
    ["holding a #, which .env would read as a comment", "a-secret-long-enough-to-use#but-commented"],
    ["holding a space", "a secret long enough to use but with spaces"],
  ])("is generated instead of a shell JWT_SECRET %s", (_case, shell) => {
    process.env["JWT_SECRET"] = shell
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    scaffold(dir, defaultScaffoldOptions("acme"))

    const secret = readEnvFile(dir)["JWT_SECRET"] ?? ""
    expect(secret).not.toBe(shell)
    expect(secret).toMatch(/^[A-Za-z0-9_-]{64}$/)
  })
})

