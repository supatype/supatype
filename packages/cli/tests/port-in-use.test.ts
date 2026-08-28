import { createServer, type Server } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { isPortInUse } from "../src/postgres-ctl.js"

/**
 * `supatype dev` asks this before handing a port to Docker Compose, so a wrong answer costs a
 * failed `compose up`, not a warning:
 *
 *     Bind for 0.0.0.0:5432 failed: port is already allocated
 *
 * The Docker case cannot be reproduced here, because it needs Docker Desktop's port proxy, which
 * publishes without holding a bind that a socket can see. It is why this function connects as well
 * as binds; the loopback case below is what a unit test can hold onto.
 */

// Ports in the high range this repository does not otherwise use.
const PORT = 19871

let server: Server | null = null

function listen(port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const created = createServer()
    created.once("error", reject)
    created.listen(port, host, () => resolve(created))
  })
}

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
})

describe("isPortInUse", () => {
  it("reports a free port as free", async () => {
    await expect(isPortInUse(PORT)).resolves.toBe(false)
  })

  it("reports a port with a loopback listener as in use", async () => {
    server = await listen(PORT, "127.0.0.1")
    await expect(isPortInUse(PORT)).resolves.toBe(true)
  })

  it("reports a port with a wildcard listener as in use", async () => {
    server = await listen(PORT, "0.0.0.0")
    await expect(isPortInUse(PORT)).resolves.toBe(true)
  })

  it("reports the port free again once the listener closes", async () => {
    server = await listen(PORT, "127.0.0.1")
    await expect(isPortInUse(PORT)).resolves.toBe(true)
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    await expect(isPortInUse(PORT)).resolves.toBe(false)
  })
})
