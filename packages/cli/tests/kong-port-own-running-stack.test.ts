import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 0.9.1 release test FF1: on a self-host stack whose `.env` follows the VM guide, with no
 * SUPATYPE_KONG_PORT, compose publishes Kong on its default, 18473. `supatype push` found 18473 in
 * use, by that same stack, took it for someone else's and waited 120 s on the next free port
 * (18481), where nothing listened. The project's own stack on the default port is its gateway, as it
 * already was for a port `.env` names.
 */

/** The ports bound on this machine, the compose project Docker says publishes each, and the ports Docker was asked about. */
const machine = vi.hoisted(() => ({ bound: new Map<number, string>(), asked: [] as number[] }))

vi.mock("../src/postgres-ctl.js", () => ({ isPortInUse: vi.fn(async (port: number) => machine.bound.has(port)) }))
vi.mock("../src/docker-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-exec.js")>()),
  askDockerSync: (args: readonly string[]) => {
    const filter = args.find((arg) => arg.startsWith("publish="))
    const port = filter === undefined ? undefined : Number(filter.slice("publish=".length))
    if (port !== undefined) machine.asked.push(port)
    const owner = port === undefined ? undefined : machine.bound.get(port)
    return { status: 0, stdout: owner === undefined ? "" : `${owner}\n`, stderr: "", timedOut: false, missing: false }
  },
}))

const { ensureDevDbPort, ensureKongPort } = await import("../src/dev-ports.js")
type Reader = NonNullable<NonNullable<Parameters<typeof ensureKongPort>[1]>["portReader"]>

/** Docker as it answers with no other Supatype stack configured. */
const noOtherStacks: Reader = { listContainers: async () => "", portBindings: async () => "" }

let cwd = ""

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-kong-own-stack-"))
  machine.bound.clear()
  machine.asked.length = 0
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const resolve = (composeProject: string) =>
  ensureKongPort(cwd, { interactive: false, env: {}, composeProject, portReader: noOtherStacks })

describe("the Kong port of a project with none in .env", () => {
  it("is the default port when the project's own running stack publishes it", async () => {
    machine.bound.set(18473, "supatype-team-notes-prod")
    expect(await resolve("supatype-team-notes-prod")).toBe(18473)
  })

  it("moves past the default port when another project's stack publishes it", async () => {
    machine.bound.set(18473, "supatype-someone-else")
    expect(await resolve("supatype-team-notes-prod")).toBe(18474)
  })

  // Another stack configured with the default but stopped holds nothing: nothing listens there, so
  // no stack publishes it and Docker is not asked, a blocking call on a busy machine.
  it("moves past a default port another stopped stack is configured with, without asking Docker who holds it", async () => {
    const stoppedStack: Reader = {
      listContainers: async () => "c1 supatype-someone-else\n",
      portBindings: async () => '{"8000/tcp":[{"HostIp":"","HostPort":"18473"}]}\n',
    }
    expect(await ensureKongPort(cwd, { interactive: false, env: {}, composeProject: "supatype-team-notes", portReader: stoppedStack })).toBe(18474)
    expect(machine.asked).not.toContain(18473)
  })
})

// 0.9.2 review: the database port took the same check only for a port .env names. With none there,
// compose publishes the database on the default, and the project's own running database was taken
// for a stranger's: the next free port was saved, and DATABASE_URL pointed where nothing listened.
describe("the dev database port of a project with none in .env", () => {
  const dbPortIn = (): string | undefined => /^SUPATYPE_DEV_DB_PORT=(\d+)$/m.exec(readFileSync(join(cwd, ".env"), "utf8"))?.[1]

  it("is the default port when the project's own running database publishes it", async () => {
    machine.bound.set(54329, "supatype-team-notes")
    expect(await ensureDevDbPort(cwd, { composeProject: "supatype-team-notes" })).toBe(54329)
    expect(dbPortIn()).toBe("54329")
  })

  it("moves past the default port when another project's database publishes it", async () => {
    machine.bound.set(54329, "supatype-someone-else")
    expect(await ensureDevDbPort(cwd, { composeProject: "supatype-team-notes" })).toBe(54330)
    expect(dbPortIn()).toBe("54330")
  })
})
