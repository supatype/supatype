import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cliDatabaseUrlLines } from "../src/database-url-owner.js"

/**
 * Issue 41, as Nic decided it: a command that needs the project's local Docker stack refuses, before
 * doing anything, while that stack is not running, with one message naming the two ways to start
 * it. `push` started Postgres and then the whole stack, `diff` started Postgres; nothing starts
 * either any more. seed keeps its "environment not set up" exit code, 2; the others exit 1.
 *
 * The real CLI runs here against a `docker` that answers as a running Docker with no containers.
 * Needs `pnpm build`.
 */

const CLI = resolve(import.meta.dirname, "../bin/supatype.js")
const FAKE_DOCKER = resolve(import.meta.dirname, "fixtures/fake-docker")
let dir = ""
let log = ""

const CONFIG = `export default {
  project: { name: "stackless" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
}
`

const SCHEMA = `import type { Model, UUID } from "@supatype/types"

export type Note = Model<{
  id: UUID
  body: string
}>
`

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "st-local-stack-required-"))
  writeFileSync(join(dir, "supatype.config.ts"), CONFIG)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "stackless", private: true, type: "module" }))
  // As init writes it: the CLI's own DATABASE_URL for the stack's database, which these commands
  // reached whether the stack ran or not.
  const url = "postgresql://supatype_admin:pw-local-1234@127.0.0.1:54329/stackless"
  const env = ["POSTGRES_PASSWORD=pw-local-1234", "POSTGRES_DB=stackless", "SUPATYPE_KONG_PORT=55561", cliDatabaseUrlLines(url)]
  writeFileSync(join(dir, ".env"), `${env.join("\n")}\n`)
  mkdirSync(join(dir, "schema"))
  writeFileSync(join(dir, "schema", "index.ts"), SCHEMA)
  log = join(dir, "docker-calls.log")
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** This process's environment with the fake docker first on PATH and the real one taken off. */
function environment(): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH"
  const rest = (process.env[pathKey] ?? "")
    .split(delimiter)
    .filter((entry) => !["docker", "docker.exe"].some((name) => existsSync(join(entry, name))))
  const env: NodeJS.ProcessEnv = { ...process.env, [pathKey]: [FAKE_DOCKER, ...rest].join(delimiter) }
  delete env["DATABASE_URL"]
  return { ...env, FAKE_DOCKER_LOG: log, FAKE_DOCKER_NODE: process.execPath, CI: "1", NO_COLOR: "1" }
}

/** `supatype <args>` in the project: its exit code, what it printed, and each docker call it made. */
function run(args: string[]): { code: number | null; out: string; calls: string[] } {
  writeFileSync(log, "")
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: environment(), encoding: "utf8", timeout: 45_000 })
  const calls = readFileSync(log, "utf8").split("\n").filter((line) => line !== "")
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, calls }
}

/** A docker call that would start something: `up`, `run` or `start`, in compose or not. */
function starts(call: string): boolean {
  return /(^|\s)(up|run|start|create)(\s|$)/.test(call)
}

const COMMANDS: Array<[string[], string, number]> = [
  [["push", "--yes"], "push", 1],
  [["diff"], "diff", 1],
  [["adopt", "--yes"], "adopt", 1],
  [["seed"], "seed", 2],
  [["migrate"], "migrate", 1],
  [["migrations", "list"], "migrations list", 1],
  [["rollback", "--no-sync-schema"], "rollback", 1],
  [["introspect"], "introspect", 1],
  [["pull", "--dry-run"], "pull", 1],
  [["doctor"], "doctor", 1],
  [["admin", "list-users"], "admin list-users", 1],
  [["reset", "--yes"], "reset", 1],
]

describe("a command that needs the local stack, with the stack not running", () => {
  it.each(COMMANDS)("supatype %s refuses, naming how to start the stack, and starts nothing", (args, name, exit) => {
    const { code, out, calls } = run(args)
    expect(out).toContain(
      `The local stack isn't running. Start it with \`supatype dev\`, or \`supatype self-host compose up -d\` on a server, then run \`supatype ${name}\` again.`,
    )
    expect(code).toBe(exit)
    expect(calls.filter(starts)).toEqual([])
  }, 60_000)

  it("supatype push --connection goes to the database it was given, not to the stack", () => {
    const { out } = run(["push", "--yes", "--connection", "postgresql://u:p@127.0.0.1:1/none"])
    expect(out).not.toContain("The local stack isn't running")
  }, 60_000)
})
