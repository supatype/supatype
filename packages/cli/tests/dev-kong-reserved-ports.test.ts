import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * M2b: `supatype dev` picks the Kong port on a project's first run, and that pick asked only the
 * OS. A stopped stack of another Supatype project holds no port, so the OS said 18473 was free and
 * the two projects clashed the first time both ran. The pick now also skips every port another
 * Supatype compose project is configured with, running or stopped. The project's own containers
 * do not count: re-running dev for it keeps the port it already has.
 */

vi.mock("../src/postgres-ctl.js", () => ({ isPortInUse: vi.fn(async () => false) }))

const { ensureKongPort } = await import("../src/dev-ports.js")
type Reader = NonNullable<NonNullable<Parameters<typeof ensureKongPort>[1]>["portReader"]>

/** Docker as it answers with one stopped stack, `supatype-other`, configured with Kong on 18473. */
const reader: Reader = {
  listContainers: async () => "k1 supatype-other\n",
  portBindings: async (ids) =>
    ids.map((id) => (id === "k1" ? '{"8000/tcp":[{"HostIp":"","HostPort":"18473"}]}' : "{}")).join("\n"),
}

let cwd = ""

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-kong-reserved-"))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe("the Kong port dev picks on a first run", () => {
  it("skips a port a stopped stranger project is configured to publish", async () => {
    const port = await ensureKongPort(cwd, {
      interactive: false,
      env: {},
      composeProject: "supatype-mine",
      portReader: reader,
    })
    expect(port).toBe(18474)
  })

  it("keeps a port the project's own stack is configured with", async () => {
    const port = await ensureKongPort(cwd, {
      interactive: false,
      env: {},
      composeProject: "supatype-other",
      portReader: reader,
    })
    expect(port).toBe(18473)
  })
})
