import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * M2: `supatype init` chose Kong 18473 while another project's stopped stack was configured to
 * publish it. A stopped container holds no port, so "is it free" said yes, and the two projects
 * clashed the first time both ran. Init now also skips every port a Supatype compose project is
 * configured with, running or stopped, as Docker reports them.
 */

vi.mock("../src/postgres-ctl.js", () => ({ isPortInUse: vi.fn(async () => false) }))
// The wizard must not ask for a port the shell already gave: any prompt fails the test.
vi.mock("../src/ui/clack.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/clack.js")>()
  const refuse = (): never => {
    throw new Error("prompted for a port")
  }
  return { ...actual, p: { ...actual.p, text: refuse, select: refuse } }
})

const { chooseInitKongPort, promptKongPortChoice, reservedComposePorts } = await import("../src/dev-ports.js")
type Reader = Parameters<typeof reservedComposePorts>[0]

/** Docker as it answers with one stopped Supatype stack on 18473 and 54329, and a stranger's. */
function reader(overrides: Partial<NonNullable<Reader>> = {}): NonNullable<Reader> {
  return {
    listContainers: () => ["a1 supatype-other", "b2 supatype-other", "c3 someone-elses-app", ""].join("\n"),
    portBindings: (ids) =>
      ids
        .map((id) =>
          id === "a1"
            ? '{"8000/tcp":[{"HostIp":"","HostPort":"18473"}]}'
            : id === "b2"
              ? '{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"54329"}]}'
              : '{"80/tcp":[{"HostIp":"","HostPort":"18475"}]}',
        )
        .join("\n"),
    ...overrides,
  }
}

describe("ports init will not hand out", () => {
  let asked: string[][] = []
  beforeEach(() => {
    asked = []
  })

  it("include every port a stopped Supatype stack is configured with", async () => {
    expect([...(await reservedComposePorts(reader()))].sort()).toEqual([18473, 54329])
  })

  it("leave out projects that are not Supatype's", async () => {
    const seen = reader({
      portBindings: (ids) => {
        asked.push([...ids])
        return reader().portBindings(ids)
      },
    })
    await reservedComposePorts(seen)
    expect(asked).toEqual([["a1", "b2"]])
  })

  it("are none when Docker cannot be asked", async () => {
    expect((await reservedComposePorts(reader({ listContainers: () => null }))).size).toBe(0)
    expect((await reservedComposePorts(reader({ portBindings: () => null }))).size).toBe(0)
  })
})

describe("the Kong port init chooses", () => {
  beforeEach(() => {
    vi.stubEnv("SUPATYPE_KONG_PORT", undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("skips a port a stopped Supatype stack is configured to publish", async () => {
    expect(await chooseInitKongPort(reader())).toBe(18474)
  })

  it("is the default when no Supatype stack claims it", async () => {
    expect(await chooseInitKongPort(reader({ listContainers: () => "" }))).toBe(18473)
  })
})

describe("the Kong port init takes from the shell", () => {
  // Local test J: `SUPATYPE_KONG_PORT=18490` exported, and `init` wrote 18473 into `.env` and
  // printed "API on http://localhost:18473". Compose binds the shell's port ahead of `.env`, as
  // every other command reads it, so the project's own `.env` named a port nothing listened on.
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("is the shell's port when one is exported", async () => {
    vi.stubEnv("SUPATYPE_KONG_PORT", "18490")
    expect(await chooseInitKongPort(reader())).toBe(18490)
  })

  it("is offered without a prompt in the wizard", async () => {
    vi.stubEnv("SUPATYPE_KONG_PORT", "18490")
    expect(await promptKongPortChoice(reader())).toBe(18490)
  })

  it("is ignored when it is not a usable port", async () => {
    vi.stubEnv("SUPATYPE_KONG_PORT", "not-a-port")
    expect(await chooseInitKongPort(reader({ listContainers: () => "" }))).toBe(18473)
  })
})
