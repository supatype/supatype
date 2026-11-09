import type { Server } from "node:net"
import { describe, expect, it, vi, type MockInstance } from "vitest"

/**
 * Windows asks the user to allow a program through its firewall the first time that program
 * listens on an address other than loopback, and remembers the answer per program file. The npm
 * package runs each CLI version from its own folder, so a probe that bound `0.0.0.0` asked again
 * on every upgrade, and on every `init` and `dev` of a fresh build.
 */
const listens = vi.hoisted((): MockInstance<Server["listen"]>[] => [])

vi.mock("node:net", async (importOriginal) => {
  const net = await importOriginal<typeof import("node:net")>()
  const createServer = (): Server => {
    const server = net.createServer()
    listens.push(vi.spyOn(server, "listen"))
    return server
  }
  return { ...net, createServer, default: { ...net, createServer } }
})

const { isPortInUse } = await import("../src/postgres-ctl.js")

describe("isPortInUse", () => {
  it("binds only loopback, so Windows never asks to let the CLI through its firewall", async () => {
    await isPortInUse(19872)
    const hosts = listens.flatMap((spy) => spy.mock.calls.map((args) => String(args[1])))
    expect(hosts.length).toBeGreaterThan(0)
    expect(hosts.filter((host) => host !== "127.0.0.1")).toEqual([])
  })
})
