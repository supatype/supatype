import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ComposeRenderMode } from "../src/compose-render-mode.js"

/**
 * One rule for `.env`'s DATABASE_URL, applied by every command that writes it and every host
 * command that reads it: none, the CLI's (labelled, or exactly the URL the CLI writes), or yours.
 * The CLI's follows whatever provider and port the project runs; yours is never changed.
 */
let running: ComposeRenderMode | undefined
vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  runningStackMode: () => running,
}))

const { databaseUrlOwner, syncDatabaseUrlPort, writeCliDatabaseUrl } = await import("../src/database-url-owner.js")
const { DATABASE_URL_MARKER, MANAGED_MARKER } = await import("../src/env-file.js")
const { resolveHostDatabaseUrl } = await import("../src/host-database.js")
const { defaultScaffoldOptions, scaffold } = await import("../src/commands/init.js")
const { validateProjectConfig } = await import("../src/project-config.js")

const INIT_URL = "postgresql://supatype_admin:pw@localhost:5432/acme"
const HAND_WRITTEN = "postgresql://me:secret@localhost:5432/mine"
let dir = ""

const docker = validateProjectConfig(
  { project: { name: "acme" }, server: { mode: "dev" }, app: { mode: "none" }, database: { provider: "docker" } },
  "supatype.config.ts",
)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-db-url-rule-"))
  running = undefined
  for (const key of ["DATABASE_URL", "SUPATYPE_DEV_DB_PORT", "SUPATYPE_DB_PORT"]) vi.stubEnv(key, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function writeEnv(lines: string[]): void {
  writeFileSync(join(dir, ".env"), [...lines, "POSTGRES_PASSWORD=pw", "POSTGRES_DB=acme", ""].join("\n"), "utf8")
}

const envText = (): string => readFileSync(join(dir, ".env"), "utf8")

describe("whose DATABASE_URL it is", () => {
  it("is nobody's when .env names none", () => {
    writeEnv([])
    expect(databaseUrlOwner(dir)).toBe("none")
  })

  it("is the CLI's under its label, under the older markers, or in the exact shape it writes", () => {
    for (const label of [DATABASE_URL_MARKER, MANAGED_MARKER, "# supatype:managed, value from versions in supatype.config.ts"]) {
      writeEnv([label, "DATABASE_URL=postgresql://other:x@db.example.test:5432/elsewhere"])
      expect(databaseUrlOwner(dir)).toBe("cli")
    }
    writeEnv([`DATABASE_URL=${INIT_URL.replace("5432", "54339")}`])
    expect(databaseUrlOwner(dir)).toBe("cli")
  })

  it("is yours otherwise, a user the CLI never writes included", () => {
    writeEnv([`DATABASE_URL=${HAND_WRITTEN}`])
    expect(databaseUrlOwner(dir)).toBe("you")
    writeEnv(["POSTGRES_USER=bob", "DATABASE_URL=postgresql://bob:pw@localhost:5432/acme"])
    expect(databaseUrlOwner(dir)).toBe("you")
  })
})

describe("the label above a URL the CLI owns", () => {
  it("is written by init, directly above the URL", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    scaffold(dir, defaultScaffoldOptions("acme"))
    expect(envText()).toMatch(new RegExp(`^${DATABASE_URL_MARKER}\\nDATABASE_URL=`, "m"))
  })

  it("replaces an older marker when the CLI rewrites the URL", () => {
    writeEnv([MANAGED_MARKER, `DATABASE_URL=${INIT_URL}`])
    writeCliDatabaseUrl(dir, INIT_URL.replace("5432", "5433"))
    expect(envText()).toContain(`${DATABASE_URL_MARKER}\nDATABASE_URL=${INIT_URL.replace("5432", "5433")}`)
    expect(envText()).not.toContain(MANAGED_MARKER)
  })
})

describe("writing the URL", () => {
  it("never changes yours, and writes what goes with it", () => {
    writeEnv([`DATABASE_URL=${HAND_WRITTEN}`])
    expect(writeCliDatabaseUrl(dir, INIT_URL, { SUPATYPE_DEV_DB_PORT: "54333" })).toBe("yours")
    expect(envText()).toContain(`DATABASE_URL=${HAND_WRITTEN}`)
    expect(envText()).toContain("SUPATYPE_DEV_DB_PORT=54333")
  })

  it("moves the port of the CLI's alone, yours staying on its own", () => {
    writeEnv([`DATABASE_URL=${HAND_WRITTEN}`, "SUPATYPE_DB_PORT=5433"])
    expect(syncDatabaseUrlPort(dir, false)).toBeNull()
    expect(envText()).toContain(`DATABASE_URL=${HAND_WRITTEN}`)
    writeEnv([`DATABASE_URL=${INIT_URL}`, "SUPATYPE_DB_PORT=5433"])
    expect(syncDatabaseUrlPort(dir, false)).toEqual({ from: "5432", to: "5433", envKey: "SUPATYPE_DB_PORT" })
    expect(envText()).toContain(`${DATABASE_URL_MARKER}\nDATABASE_URL=${INIT_URL.replace("5432", "5433")}`)
  })

  it("leaves this run's environment alone for a port the shell gives over a URL that is yours", () => {
    writeEnv([`DATABASE_URL=${HAND_WRITTEN}`])
    const shell: NodeJS.ProcessEnv = { SUPATYPE_DEV_DB_PORT: "54339" }
    expect(syncDatabaseUrlPort(dir, true, shell)).toBeNull()
    expect(shell["DATABASE_URL"]).toBeUndefined()
  })
})

describe("a Docker project's host commands", () => {
  it("reach the running stack's port past a URL the CLI wrote for another", () => {
    running = "dev"
    writeEnv([`DATABASE_URL=${INIT_URL}`, "SUPATYPE_DEV_DB_PORT=54333"])
    expect(resolveHostDatabaseUrl(dir, docker, { allowDerived: true }).dsn).toContain("127.0.0.1:54333/acme")
  })

  it("use the CLI's URL as written when no stack runs, and yours always", () => {
    writeEnv([`DATABASE_URL=${INIT_URL}`])
    expect(resolveHostDatabaseUrl(dir, docker, { allowDerived: true }).dsn).toBe(INIT_URL)
    running = "dev"
    writeEnv([`DATABASE_URL=${HAND_WRITTEN}`, "SUPATYPE_DEV_DB_PORT=54333"])
    expect(resolveHostDatabaseUrl(dir, docker, { allowDerived: true }).dsn).toBe(HAND_WRITTEN)
  })
})

describe("native dev and a port only the shell gives", () => {
  it("points this run at the native database and leaves .env's URL as it was", async () => {
    const { reconcileNativeDatabaseUrl } = await import("../src/database-url-owner.js")
    vi.stubEnv("SUPATYPE_DEV_DB_PORT", "54339")
    writeEnv([`DATABASE_URL=${INIT_URL}`])
    const native = "postgres://postgres:pw@127.0.0.1:54339/acme?sslmode=disable"
    await reconcileNativeDatabaseUrl(dir, native)
    expect(envText()).toContain(`DATABASE_URL=${INIT_URL}`)
    expect(process.env["DATABASE_URL"]).toBe(native)
  })
})
