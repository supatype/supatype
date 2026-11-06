import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { upsertEnvFile } from "../src/env-file.js"
import { withEnvValue } from "../src/env-lines.js"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"

/**
 * Manual test #37: init took an admin email holding carriage returns and wrote it to `.env` as it
 * was. The server read the text after each one as a line of its own, refused to start, and logged
 * those lines, the admin password among them. No env file writer puts a line break or any other
 * control character into a value: it refuses, naming the key and never the value, and leaves the
 * file as it was.
 */
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-env-refusal-"))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const SECRET = "hunter2-secret"
const BEFORE = "# kept as it is\nJWT_SECRET=abc\n"
const UNWRITABLE = [
  ["a carriage return", `admin@example.com\r${SECRET}`],
  ["a line feed", `admin@example.com\n${SECRET}`],
  ["a NUL", `admin@example.com\u0000${SECRET}`],
  ["a tab", `admin@example.com\t${SECRET}`],
  ["an escape", `admin@example.com\u001b${SECRET}`],
  ["a DEL", `admin@example.com\u007f${SECRET}`],
  ["a line separator", `admin@example.com${String.fromCharCode(0x2028)}${SECRET}`],
  ["a paragraph separator", `admin@example.com${String.fromCharCode(0x2029)}${SECRET}`],
  ["a C1 next line", `admin@example.com${String.fromCharCode(0x85)}${SECRET}`],
] as const

/** The error `run` threw, so its message can be checked for what it must and must not say. */
function thrown(run: () => unknown): Error {
  try {
    run()
  } catch (err) {
    if (err instanceof Error) return err
    throw new Error(`threw a non-Error: ${String(err)}`)
  }
  throw new Error("did not throw")
}

describe("upsertEnvFile refuses a value it cannot write on one line", () => {
  it.each(UNWRITABLE)("with %s, naming the key and not the value", (_what, value) => {
    writeFileSync(join(dir, ".env"), BEFORE, "utf8")
    const err = thrown(() => upsertEnvFile(dir, { ANON_KEY: "fine", SUPATYPE_ADMIN_EMAIL: value }))
    expect(err.message).toContain("SUPATYPE_ADMIN_EMAIL")
    expect(err.message).not.toContain(SECRET)
    expect(err.message).not.toContain("admin@example.com")
  })

  it("leaves the file byte for byte as it was, the other updates unwritten", () => {
    writeFileSync(join(dir, ".env"), BEFORE, "utf8")
    thrown(() => upsertEnvFile(dir, { ANON_KEY: "fine", SUPATYPE_ADMIN_EMAIL: `a\r${SECRET}` }))
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(BEFORE)
  })

  it("creates no file when there was none", () => {
    thrown(() => upsertEnvFile(dir, { SUPATYPE_ADMIN_EMAIL: `a\n${SECRET}` }, { file: ".env.development.local" }))
    expect(readdirSync(dir)).toEqual([])
  })

  it("names the file it was writing", () => {
    const err = thrown(() => upsertEnvFile(dir, { KEY: "a\nb" }, { file: ".env.development.local" }))
    expect(err.message).toContain(".env.development.local")
  })

  it("still writes ordinary values, spaces and non-ASCII included", () => {
    const name = `Caf${String.fromCharCode(0xe9)} Formflow`
    upsertEnvFile(dir, { SUPATYPE_SMTP_SENDER_NAME: name, URL: "postgres://u:p@h/db" })
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`SUPATYPE_SMTP_SENDER_NAME=${name}\nURL=postgres://u:p@h/db\n`)
  })
})

describe("functions env's local writer refuses the same", () => {
  it("throws naming the key and not the value", () => {
    const err = thrown(() => withEnvValue("A=1\n", "API_TOKEN", `x\r${SECRET}`, "functions/.env.local"))
    expect(err.message).toContain("API_TOKEN")
    expect(err.message).toContain("functions/.env.local")
    expect(err.message).not.toContain(SECRET)
  })
})

describe("init's .env", () => {
  it("is refused before any file is written when an answer cannot go on one line", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const opts = { ...defaultScaffoldOptions("acme"), adminEmail: "admin@example.com", adminPassword: `pw\r${SECRET}` }
    const err = thrown(() => scaffold(dir, opts))
    expect(err.message).toContain("SUPATYPE_ADMIN_PASSWORD")
    expect(err.message).not.toContain(SECRET)
    expect(existsSync(join(dir, "package.json"))).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })
})
