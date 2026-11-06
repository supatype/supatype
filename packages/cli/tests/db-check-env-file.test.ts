import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cliDatabaseUrlLines } from "../src/database-url-owner.js"

/**
 * Issue 49: `supatype db check` is for a Postgres the project does not run (its help says so), so it
 * takes no local-stack refusal. It still has to find the database the way every other command does:
 * it ignored `.env`'s DATABASE_URL and said "No connection" with one there. And a refused connection
 * names the address it tried, never the password, and what to check.
 */

const printed = vi.hoisted(() => [] as string[])
vi.mock("../src/ui/messages.js", async (importOriginal) => {
  const record = (message?: string) => {
    printed.push(message ?? "")
  }
  return {
    ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
    error: record,
    info: record,
    plain: record,
    warn: record,
  }
})
// No stack runs for this project.
vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  runningStackMode: () => undefined,
}))

const { registerDb } = await import("../src/commands/db.js")

const PASSWORD = "pw-secret-4321"
let dir = ""
const savedUrl = process.env["DATABASE_URL"]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-db-check-"))
  const config = {
    project: { name: "acme" },
    provider: "docker",
    database: { provider: "docker" },
    server: { mode: "dev" },
    app: { mode: "none" },
  }
  writeFileSync(join(dir, "supatype.config.mjs"), `export default ${JSON.stringify(config)}\n`)
  // Port 1: nothing listens, so the connection is refused at once.
  const url = `postgresql://supatype_admin:${PASSWORD}@127.0.0.1:1/acme`
  writeFileSync(join(dir, ".env"), `POSTGRES_PASSWORD=${PASSWORD}\n${cliDatabaseUrlLines(url)}\n`)
  vi.spyOn(process, "cwd").mockReturnValue(dir)
  delete process.env["DATABASE_URL"]
  printed.length = 0
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  if (savedUrl === undefined) delete process.env["DATABASE_URL"]
  else process.env["DATABASE_URL"] = savedUrl
  process.exitCode = undefined
  rmSync(dir, { recursive: true, force: true })
})

async function dbCheck(): Promise<string> {
  const program = new Command().exitOverride()
  registerDb(program)
  await program.parseAsync(["node", "supatype", "db", "check"])
  return printed.join("\n")
}

describe("supatype db check in a project whose stack is not running", () => {
  it("connects to .env's DATABASE_URL, without the local-stack refusal", async () => {
    const out = await dbCheck()
    expect(out).not.toContain("No connection")
    expect(out).not.toContain("isn't running")
    expect(out).toContain("127.0.0.1:1")
    expect(process.exitCode).toBe(1)
  }, 20_000)

  it("a refused connection names the address and what to check, never the password", async () => {
    const out = await dbCheck()
    expect(out).toContain("Could not connect to 127.0.0.1:1")
    expect(out).toContain(`DATABASE_URL in ${join(dir, ".env")}`)
    expect(out).not.toContain(PASSWORD)
  }, 20_000)
})
