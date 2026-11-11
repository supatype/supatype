import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { devSessionLockFor, enterLocalStack, writeDevSessionLock } from "../src/dev-session-lock.js"
import { COMPOSE_DEV_DB_PORT, composeDbHostPort } from "../src/host-database.js"
import { composeKongHostPort } from "../src/local-gateway.js"
import { COMPOSE_DEV_KONG_PORT } from "../src/project-config.js"
import { selfHostComposePaths } from "../src/self-host-compose.js"
import { projectConfig } from "./support/project-config.js"

/**
 * 0.9.2 round 2 (R2-S17): `dev` started with SUPATYPE_DEV_DB_PORT in the shell keeps it out of
 * .env (a port the shell gave is the run's, DR9), so `admin create-user` and every other host
 * command, reading only the shell and .env, connected to the default 54329: another project's
 * database on that machine. The running session records the port it publishes, and a command that
 * enters the local stack takes it into its environment, where these read it.
 */
let dir = ""
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-dev-db-port-"))
  // Entering the stack writes both into this process's environment; stubbed, they are put back.
  vi.stubEnv("SUPATYPE_DEV_DB_PORT", "")
  vi.stubEnv("SUPATYPE_KONG_PORT", "")
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

/** A running `supatype dev` publishing its database on `dbPort`, and its stack entered. */
function devSession(dbPort: number): void {
  const stack = { composeProject: "supatype-run-b", composePath: selfHostComposePaths(dir).composePath, kongPort: 18740, dbPort }
  writeDevSessionLock(dir, devSessionLockFor(projectConfig({ project: { name: "acme" } }), stack))
  enterLocalStack(dir, "acme")
}

describe("the host port of a dev stack's database", () => {
  it("is the one the running dev session publishes, though neither the shell nor .env names it", () => {
    devSession(54740)
    expect(composeDbHostPort(dir, "dev")).toBe(54740)
  })

  it("wins over a port .env names, as it is the one the stack runs on", () => {
    writeFileSync(join(dir, ".env"), "SUPATYPE_DEV_DB_PORT=54741\n")
    devSession(54740)
    expect(composeDbHostPort(dir, "dev")).toBe(54740)
  })

  it("is .env's, then the default, with no session running", () => {
    expect(composeDbHostPort(dir, "dev")).toBe(COMPOSE_DEV_DB_PORT)
    writeFileSync(join(dir, ".env"), "SUPATYPE_DEV_DB_PORT=54741\n")
    expect(composeDbHostPort(dir, "dev")).toBe(54741)
  })
})

// The same for the gateway: a SUPATYPE_KONG_PORT from dev's shell is not in .env either.
describe("the host port of a dev stack's gateway", () => {
  it("is the one the running dev session publishes, else .env's, else the default", () => {
    vi.stubEnv("SUPATYPE_KONG_PORT", "")
    expect(composeKongHostPort(dir)).toBe(COMPOSE_DEV_KONG_PORT)
    devSession(54740)
    expect(composeKongHostPort(dir)).toBe(18740)
  })
})
