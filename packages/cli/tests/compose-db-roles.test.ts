import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { SpawnSyncReturns } from "node:child_process"

/**
 * Both role fixes run `psql` inside the project's `db` container, so both have to log in as the
 * project's own owner, to the project's own database.
 *
 * The auth grant did not. It hardcoded `postgres` / `supatype`, which is only right for a project
 * that never set its own, so on the kitchen sink (`POSTGRES_DB=kitchen-sink` and its own password)
 * it failed authentication on every start, left `service_role` without `SELECT` on `auth.users`,
 * and said only that Studio "may" fail. CI never saw it: the e2e started with no `.env`, so the
 * fallbacks the grant hardcoded were the values the stack was created with.
 */

type Spawned = Partial<SpawnSyncReturns<string>>
const spawnSync = vi.fn<(cmd: string, args: readonly string[], opts: { input?: string }) => Spawned>()
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (cmd: string, args: readonly string[], opts: { input?: string }) =>
    spawnSync(cmd, args, opts),
}))

const { grantAuthSchemaAccess, reconcileAuthenticatorPassword } = await import(
  "../src/compose-db-roles.js"
)

const PROJECT_ENV = [
  "POSTGRES_USER=ks_owner",
  "POSTGRES_PASSWORD=ks-own-password",
  "POSTGRES_DB=kitchen-sink",
  "AUTHENTICATOR_PASSWORD=ks-authenticator",
  "",
].join("\n")

const AUTH_FAILED: Spawned = {
  status: 2,
  stdout: "",
  stderr: "FATAL: password authentication failed",
}

let cwd: string
let previousStrict: string | undefined
const paths = () => ({ composePath: join(cwd, ".supatype", "self-host", "docker-compose.yml") })

/** The `psql` invocation from the one `docker` call the function made. */
function psqlCall(): { args: readonly string[]; input: string | undefined } {
  expect(spawnSync).toHaveBeenCalledTimes(1)
  const [, args, opts] = spawnSync.mock.calls[0]!
  return { args, input: opts.input }
}

/** The value after `flag` in an argument list. */
function after(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-db-roles-"))
  writeFileSync(join(cwd, ".env"), PROJECT_ENV, "utf8")
  spawnSync.mockReset()
  spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" })
  previousStrict = process.env["SUPATYPE_STRICT"]
  delete process.env["SUPATYPE_STRICT"]
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
  if (previousStrict === undefined) delete process.env["SUPATYPE_STRICT"]
  else process.env["SUPATYPE_STRICT"] = previousStrict
  vi.restoreAllMocks()
})

describe.each([
  ["grantAuthSchemaAccess", grantAuthSchemaAccess],
  ["reconcileAuthenticatorPassword", reconcileAuthenticatorPassword],
] as const)("%s", (_name, run) => {
  it("logs in as the project's owner, to the project's database, with its password", () => {
    run(paths(), cwd, "supatype-kitchen-sink")
    const { args } = psqlCall()

    expect(after(args, "-U")).toBe("ks_owner")
    expect(after(args, "-d")).toBe("kitchen-sink")
    expect(args).toContain("PGPASSWORD=ks-own-password")
    expect(args).not.toContain("PGPASSWORD=postgres")
  })

  it("says why psql failed, not only what may break", () => {
    spawnSync.mockReturnValue(AUTH_FAILED)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    run(paths(), cwd, "supatype-kitchen-sink")

    expect(warn.mock.calls.flat().join("\n")).toContain("password authentication failed")
  })

  it("fails under SUPATYPE_STRICT=1, so a CI job cannot pass over it", () => {
    spawnSync.mockReturnValue(AUTH_FAILED)
    process.env["SUPATYPE_STRICT"] = "1"

    expect(() => run(paths(), cwd, "supatype-kitchen-sink")).toThrow(
      /password authentication failed/,
    )
  })
})

describe("grantAuthSchemaAccess", () => {
  it("grants service_role what Studio's relation preview reads", () => {
    grantAuthSchemaAccess(paths(), cwd, "supatype-kitchen-sink")
    const { input } = psqlCall()

    expect(input).toContain("GRANT USAGE ON SCHEMA auth TO service_role;")
    expect(input).toContain("GRANT SELECT ON auth.users TO service_role;")
  })
})

describe("reconcileAuthenticatorPassword", () => {
  it("hands the new password to psql through the environment, not the command line", () => {
    reconcileAuthenticatorPassword(paths(), cwd, "supatype-kitchen-sink")
    const { args, input } = psqlCall()

    expect(args).toContain("SUPATYPE_AUTHENTICATOR_PASSWORD=ks-authenticator")
    expect(input).toContain("\\getenv pw SUPATYPE_AUTHENTICATOR_PASSWORD")
    expect(args.join(" ")).not.toContain("ALTER ROLE")
  })
})
