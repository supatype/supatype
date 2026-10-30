import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { offerToSaveShellDbPort, reconcileNativeDevDatabaseUrl, type DbPortAsk } from "../src/db-port-offer.js"
import { MANAGED_MARKER } from "../src/env-file.js"

/**
 * Local test C: Docker dev with `SUPATYPE_DEV_DB_PORT=54339` exported moved `DATABASE_URL` for its
 * own process only, so `admin list-users` and `seed --status` from another shell went to 5432,
 * where nothing listened. Dev now asks whether to keep the port, when someone can answer, and
 * otherwise names the line that keeps it, writing nothing.
 */
// Marked as the CLI's: a hand-written URL is never offered over (database-url-owner-docker.test.ts).
const URL_5432 = `${MANAGED_MARKER}\nDATABASE_URL=postgresql://supatype_admin:pw%2Fx@localhost:5432/acme?sslmode=disable`
let dir = ""
let printed: string[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-db-port-offer-"))
  printed = []
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void printed.push(args.join(" ")))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function writeEnv(text: string): void {
  writeFileSync(join(dir, ".env"), text, "utf8")
}

function envText(): string {
  return readFileSync(join(dir, ".env"), "utf8")
}

/** Someone at a terminal who answers `answer`, or nobody when `answer` is undefined. */
function asker(answer: boolean | undefined): DbPortAsk & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    interactive: () => answer !== undefined,
    confirm: async (question) => {
      asked.push(question)
      return answer === true
    },
  }
}

const shell = { SUPATYPE_DEV_DB_PORT: "54339" }

describe("offerToSaveShellDbPort", () => {
  it("saves the port and moves DATABASE_URL in .env when the answer is yes", async () => {
    writeEnv(`${URL_5432}\nPOSTGRES_PASSWORD=pw\n`)
    const ask = asker(true)
    await offerToSaveShellDbPort(dir, ask, shell)
    expect(ask.asked).toHaveLength(1)
    expect(envText()).toContain("DATABASE_URL=postgresql://supatype_admin:pw%2Fx@localhost:54339/acme?sslmode=disable")
    expect(envText()).toContain("SUPATYPE_DEV_DB_PORT=54339")
    expect(envText()).toContain("POSTGRES_PASSWORD=pw")
  })

  it("leaves .env alone when the answer is no, and says the port is this run's", async () => {
    writeEnv(`${URL_5432}\n`)
    const ask = asker(false)
    await offerToSaveShellDbPort(dir, ask, shell)
    expect(ask.asked).toHaveLength(1)
    expect(envText()).toBe(`${URL_5432}\n`)
    expect(printed.join("\n")).toMatch(/for this run only/)
  })

  it("never writes when nobody can answer, and names the line to add in one line", async () => {
    writeEnv(`${URL_5432}\n`)
    const ask = asker(undefined)
    await offerToSaveShellDbPort(dir, ask, shell)
    expect(ask.asked).toEqual([])
    expect(envText()).toBe(`${URL_5432}\n`)
    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain("SUPATYPE_DEV_DB_PORT=54339")
    expect(printed[0]).not.toContain("pw")
  })

  it("asks nothing when .env already names the shell's port", async () => {
    writeEnv("SUPATYPE_DEV_DB_PORT=54339\nDATABASE_URL=postgresql://u:p@localhost:54339/acme\n")
    const ask = asker(true)
    await offerToSaveShellDbPort(dir, ask, shell)
    expect(ask.asked).toEqual([])
    expect(printed).toEqual([])
  })

  it("asks nothing for a DATABASE_URL on another machine, or one the shell sets", async () => {
    writeEnv("DATABASE_URL=postgresql://u:p@db.example.com:5432/acme\n")
    const ask = asker(true)
    await offerToSaveShellDbPort(dir, ask, shell)
    writeEnv(`${URL_5432}\n`)
    await offerToSaveShellDbPort(dir, ask, { ...shell, DATABASE_URL: "postgresql://u:p@localhost:6000/acme" })
    expect(ask.asked).toEqual([])
    expect(envText()).toBe(`${URL_5432}\n`)
  })
})

/**
 * Local test round 3, B1: native dev never offered the shell's port, so host commands from another
 * shell kept going to `.env`'s 5432. Native dev now offers it, as Docker dev does, before it points
 * `DATABASE_URL` at the native database.
 */
describe("reconcileNativeDevDatabaseUrl", () => {
  const nativeDsn = "postgres://postgres:pw@127.0.0.1:54339/acme?sslmode=disable"

  it("names the line to add when nobody can answer, and keeps .env as it was", async () => {
    writeEnv(`${URL_5432}\n`)
    const ask = asker(undefined)
    await reconcileNativeDevDatabaseUrl(dir, nativeDsn, ask, { ...shell })
    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain("To keep it, add this line to .env: SUPATYPE_DEV_DB_PORT=54339")
    expect(envText()).toBe(`${URL_5432}\n`)
  })

  it("saves the port and points DATABASE_URL at the native database on yes", async () => {
    writeEnv(`${URL_5432}\n`)
    const ask = asker(true)
    await reconcileNativeDevDatabaseUrl(dir, nativeDsn, ask, { ...shell })
    expect(ask.asked).toHaveLength(1)
    expect(envText()).toContain("SUPATYPE_DEV_DB_PORT=54339")
    expect(envText()).toContain(`DATABASE_URL=${nativeDsn}`)
  })
})
