import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface SpawnOptions { env?: NodeJS.ProcessEnv }
const spawnSync = vi.fn<(cmd: string, args: readonly string[], opts?: SpawnOptions) => { status: number }>()
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (cmd: string, args: readonly string[], opts?: SpawnOptions) => spawnSync(cmd, args, opts),
}))
vi.mock("../src/docker-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-runtime.js")>()),
  requireDockerDaemon: () => undefined,
}))

const { runDockerCompose } = await import("../src/self-host-compose.js")

/**
 * Compose takes a variable from the shell ahead of `--env-file`. The keys in `.env` are signed with
 * `.env`'s JWT_SECRET, so a different one exported in the shell started the stack verifying with a
 * secret those keys do not match, and every request was refused with a 401.
 */
const NAMES = ["JWT_SECRET", "ANON_KEY", "SERVICE_ROLE_KEY"] as const
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]))
let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compose-shell-secret-"))
  spawnSync.mockReset()
  spawnSync.mockReturnValue({ status: 0 })
  for (const name of NAMES) process.env[name] = `shell-${name}`
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const name of NAMES) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

/** The environment compose was started with. */
function composeEnv(): NodeJS.ProcessEnv {
  runDockerCompose(join(dir, "docker-compose.yml"), ["ps"], dir)
  return spawnSync.mock.calls[0]?.[2]?.env ?? {}
}

describe("the environment docker compose runs with", () => {
  it("leaves out the shell's JWT_SECRET and keys when .env defines them", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=from-env-file\nANON_KEY=a\nSERVICE_ROLE_KEY=s\n")
    const env = composeEnv()
    for (const name of NAMES) expect(env[name]).toBeUndefined()
  })

  it("leaves out the shell's keys once .env holds a JWT_SECRET, even while its own are blank", () => {
    // A shell key is signed with some other secret, which PostgREST, on .env's, would refuse.
    writeFileSync(join(dir, ".env"), "JWT_SECRET=from-env-file\nANON_KEY=\n")
    const env = composeEnv()
    for (const name of NAMES) expect(env[name]).toBeUndefined()
  })

  it("keeps the shell's secret and keys .env neither defines nor signs", () => {
    writeFileSync(join(dir, ".env"), "ANON_KEY=a\nSERVICE_ROLE_KEY=\n")
    const env = composeEnv()
    expect(env["ANON_KEY"]).toBeUndefined()
    expect(env["JWT_SECRET"]).toBe("shell-JWT_SECRET")
    expect(env["SERVICE_ROLE_KEY"]).toBe("shell-SERVICE_ROLE_KEY")
  })
})
