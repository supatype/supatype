import { mkdtempSync, rmSync } from "node:fs"
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

/** The ports bound on this machine, and the compose project Docker says publishes each. */
const machine = vi.hoisted(() => ({ bound: new Map<number, string>() }))

vi.mock("../src/postgres-ctl.js", () => ({ isPortInUse: vi.fn(async (port: number) => machine.bound.has(port)) }))
vi.mock("../src/docker-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-exec.js")>()),
  askDockerSync: (args: readonly string[]) => {
    const filter = args.find((arg) => arg.startsWith("publish="))
    const owner = filter === undefined ? undefined : machine.bound.get(Number(filter.slice("publish=".length)))
    return { status: 0, stdout: owner === undefined ? "" : `${owner}\n`, stderr: "", timedOut: false, missing: false }
  },
}))

const { ensureKongPort } = await import("../src/dev-ports.js")
type Reader = NonNullable<NonNullable<Parameters<typeof ensureKongPort>[1]>["portReader"]>

/** Docker as it answers with no other Supatype stack configured. */
const noOtherStacks: Reader = { listContainers: async () => "", portBindings: async () => "" }

let cwd = ""

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-kong-own-stack-"))
  machine.bound.clear()
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
})
