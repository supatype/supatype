import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * M2: `supatype init` chose Kong 18473 while another project's stopped stack was configured to
 * publish it. A stopped container holds no port, so "is it free" said yes, and the two projects
 * clashed the first time both ran. Init now also skips every port a Supatype compose project is
 * configured with, running or stopped, as Docker reports them.
 */

vi.mock("../src/postgres-ctl.js", () => ({ isPortInUse: vi.fn(async () => false) }))

const { chooseInitKongPort, reservedComposePorts } = await import("../src/dev-ports.js")
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

  it("include every port a stopped Supatype stack is configured with", () => {
    expect([...reservedComposePorts(reader())].sort()).toEqual([18473, 54329])
  })

  it("leave out projects that are not Supatype's", () => {
    const seen = reader({
      portBindings: (ids) => {
        asked.push([...ids])
        return reader().portBindings(ids)
      },
    })
    reservedComposePorts(seen)
    expect(asked).toEqual([["a1", "b2"]])
  })

  it("are none when Docker cannot be asked", () => {
    expect(reservedComposePorts(reader({ listContainers: () => null })).size).toBe(0)
    expect(reservedComposePorts(reader({ portBindings: () => null })).size).toBe(0)
  })
})

describe("the Kong port init chooses", () => {
  it("skips a port a stopped Supatype stack is configured to publish", async () => {
    expect(await chooseInitKongPort(reader())).toBe(18474)
  })

  it("is the default when no Supatype stack claims it", async () => {
    expect(await chooseInitKongPort(reader({ listContainers: () => "" }))).toBe(18473)
  })
})
