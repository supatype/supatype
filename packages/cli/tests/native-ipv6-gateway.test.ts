import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { NativePortClaim } from "../src/commands/dev.js"
import { freePort } from "./support/ports.js"

/**
 * 0.9.2 round 2 (R2-S22): on native Windows, with something else on [::1] at the API server's port,
 * dev served on 127.0.0.1 alone and no pane said so, while `localhost` there resolves to ::1 first:
 * a browser on http://localhost reached the other listener. Dev says so in one line.
 */
vi.mock("../src/ui/fatal.js", () => ({
  fatalError: (message: string, hints: string[] = []): never => {
    throw new Error([message, ...hints].join("\n"))
  },
}))

const { claimNativeDevPorts } = await import("../src/commands/dev.js")

const roots: string[] = []
const servers: Server[] = []
const claims: NativePortClaim[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const claim of claims.splice(0)) claim.postgrest.release()
  for (const server of servers.splice(0)) server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Listens on [::1]:`port`; false when this machine has no IPv6 loopback to listen on. */
function holdIpv6(port: number): Promise<boolean> {
  const server = createServer()
  servers.push(server)
  return new Promise((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(port, "::1", () => resolve(true))
  })
}

/** The lines dev warned with while checking `server`'s port, among its other free ports. */
async function warningsFor(server: number): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "supatype-ipv6-gateway-"))
  roots.push(root)
  const ports = { postgres: await freePort(), server, postgrest: await freePort(), realtime: await freePort() }
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  claims.push(await claimNativeDevPorts(ports, { dataDir: join(root, "data"), pidDir: join(root, "pid") }))
  return warn.mock.calls.flat().join("\n")
}

describe("the API server's port held on [::1] by something else", () => {
  it("is said, with the IPv4 address dev serves on", async (context) => {
    const port = await freePort()
    if (!(await holdIpv6(port))) context.skip()
    const said = await warningsFor(port)
    expect(said).toContain(`[::1]:${port}`)
    expect(said).toContain(`http://127.0.0.1:${port}`)
  })

  it("is not said when [::1] is free", async () => {
    expect(await warningsFor(await freePort())).not.toContain("[::1]")
  })
})
