import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { SpawnSyncReturns } from "node:child_process"
import type { FakeRun } from "./support/fake-exec-file.js"
import { expectQuietBeforePassword } from "./support/quiet-sql.js"

/**
 * Both role fixes run `psql` inside the project's `db` container, so both have to log in as the
 * bundled superuser, with the project's own password, to the project's own database.
 *
 * The auth grant did not. It hardcoded `postgres` / `supatype`, which is only right for a project
 * that never set its own, so on the kitchen sink (`POSTGRES_DB=kitchen-sink` and its own password)
 * it failed authentication on every start, left `service_role` without `SELECT` on `auth.users`,
 * and said only that Studio "may" fail. CI never saw it: the e2e started with no `.env`, so the
 * fallbacks the grant hardcoded were the values the stack was created with.
 */

type Spawned = Partial<SpawnSyncReturns<string>>
interface SpawnOptions { input?: string | undefined; env?: NodeJS.ProcessEnv | undefined }
// psql runs through `execFile`, asynchronously: the auth grant follows every docker dev push.
const ran = vi.fn<(cmd: string, args: readonly string[], opts: SpawnOptions) => Spawned>()
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>()
  const { fakeExecFile } = await import("./support/fake-exec-file.js")
  const answer = (cmd: string, args: readonly string[], opts: SpawnOptions): FakeRun => {
    const run = ran(cmd, args, opts)
    return { status: run.status ?? null, stdout: run.stdout ?? "", stderr: run.stderr ?? "" }
  }
  return { ...real, execFile: fakeExecFile(answer, () => new real.ChildProcess()) }
})

const { grantAuthSchemaAccess, reconcileAuthenticatorPassword, reconcileSqlEditorPassword } =
  await import("../src/compose-db-roles.js")

const PROJECT_ENV = [
  "POSTGRES_USER=supatype_admin",
  "POSTGRES_PASSWORD=ks-own-password",
  "POSTGRES_DB=kitchen-sink",
  "AUTHENTICATOR_PASSWORD=ks-authenticator",
  "SUPATYPE_SQL_EDITOR_PASSWORD=ks-sql-editor",
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
function psqlCall(): { args: readonly string[]; input: string | undefined; env: NodeJS.ProcessEnv } {
  expect(ran).toHaveBeenCalledTimes(1)
  const [, args, opts] = ran.mock.calls[0]!
  return { args, input: opts.input, env: opts.env ?? {} }
}

/** The value after `flag` in an argument list. */
function after(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-db-roles-"))
  writeFileSync(join(cwd, ".env"), PROJECT_ENV, "utf8")
  ran.mockReset()
  ran.mockReturnValue({ status: 0, stdout: "", stderr: "" })
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
  ["reconcileSqlEditorPassword", reconcileSqlEditorPassword],
] as const)("%s", (_name, run) => {
  it("logs in as the bundled superuser, to the project's database, with its password", async () => {
    await run(paths(), cwd, "supatype-kitchen-sink")
    const { args, env } = psqlCall()

    expect(after(args, "-U")).toBe("supatype_admin")
    expect(after(args, "-d")).toBe("kitchen-sink")
    expect(after(args, "-e")).toBe("PGPASSWORD")
    expect(env["PGPASSWORD"]).toBe("ks-own-password")
    expect(args.join(" ")).not.toContain("ks-own-password")
  })

  it("says why psql failed, not only what may break", async () => {
    ran.mockReturnValue(AUTH_FAILED)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await run(paths(), cwd, "supatype-kitchen-sink")

    expect(warn.mock.calls.flat().join("\n")).toContain("password authentication failed")
  })

  it("fails under SUPATYPE_STRICT=1, so a CI job cannot pass over it", async () => {
    ran.mockReturnValue(AUTH_FAILED)
    process.env["SUPATYPE_STRICT"] = "1"

    await expect(run(paths(), cwd, "supatype-kitchen-sink")).rejects.toThrow(
      /password authentication failed/,
    )
  })
})

describe("grantAuthSchemaAccess", () => {
  it("grants service_role what Studio's relation preview reads", async () => {
    await grantAuthSchemaAccess(paths(), cwd, "supatype-kitchen-sink")
    const { input } = psqlCall()

    expect(input).toContain("GRANT USAGE ON SCHEMA auth TO service_role;")
    expect(input).toContain("GRANT SELECT ON auth.users TO service_role;")
  })
})

describe("reconcileAuthenticatorPassword", () => {
  it("hands the new password to psql through the environment, not the command line", async () => {
    await reconcileAuthenticatorPassword(paths(), cwd, "supatype-kitchen-sink")
    const { args, input, env } = psqlCall()

    expect(args).toContain("SUPATYPE_AUTHENTICATOR_PASSWORD")
    expect(env["SUPATYPE_AUTHENTICATOR_PASSWORD"]).toBe("ks-authenticator")
    expect(args.join(" ")).not.toContain("ks-authenticator")
    expect(input).toContain("\\getenv pw SUPATYPE_AUTHENTICATOR_PASSWORD")
    expect(args.join(" ")).not.toContain("ALTER ROLE")
  })
})

// 0.9.2 release test round 5 (RB-1): dev reconciled the password before the image's own setup
// turned logging off for supatype_admin, and the db log tail it printed held the password.
describe.each([
  ["reconcileAuthenticatorPassword", reconcileAuthenticatorPassword],
  ["reconcileSqlEditorPassword", reconcileSqlEditorPassword],
] as const)("%s, in the db log", (_name, run) => {
  it("turns statement logging off before the statement that holds the password", async () => {
    await run(paths(), cwd, "supatype-kitchen-sink")
    expectQuietBeforePassword(psqlCall().input)
  })
})

describe("reconcileSqlEditorPassword", () => {
  it("hands the editor password to psql through the environment, not the command line", async () => {
    await reconcileSqlEditorPassword(paths(), cwd, "supatype-kitchen-sink")
    const { args, input, env } = psqlCall()

    expect(args).toContain("SUPATYPE_SQL_EDITOR_PASSWORD")
    expect(env["SUPATYPE_SQL_EDITOR_PASSWORD"]).toBe("ks-sql-editor")
    expect(args.join(" ")).not.toContain("ks-sql-editor")
    expect(input).toContain("\\getenv pw SUPATYPE_SQL_EDITOR_PASSWORD")
    expect(input).toContain("ALTER ROLE supatype_sql_editor WITH LOGIN PASSWORD %L")
    expect(args.join(" ")).not.toContain("ALTER ROLE")
  })

  // A volume made by an image older than the editor role has no such role, and the start must
  // not fail on it: the statement is generated only when the role is there.
  it("alters the role only when it exists", async () => {
    await reconcileSqlEditorPassword(paths(), cwd, "supatype-kitchen-sink")
    const { input } = psqlCall()

    expect(input).toContain("WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = 'supatype_sql_editor')")
    expect(input).toContain("\\gexec")
  })
})
