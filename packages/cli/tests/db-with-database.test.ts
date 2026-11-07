import { createServer } from "node:net"
import { describe, expect, it } from "vitest"
import { DatabaseConnectFailed, withDatabase } from "../src/db-rows.js"

/** A port nothing listens on. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0))
    })
  })
}

/**
 * The one connect, use and end for a short-lived database connection (db check, the BYO preflight,
 * native realtime's decoding check). A failure to connect is told apart from one once connected,
 * so `db check` still says "Could not connect".
 */
describe("withDatabase", () => {
  it("throws DatabaseConnectFailed, and never runs the work, when nothing answers", async () => {
    const port = await closedPort()
    let ran = false
    const attempt = withDatabase(`postgres://u:p@127.0.0.1:${port}/x`, async () => {
      ran = true
    })
    await expect(attempt).rejects.toBeInstanceOf(DatabaseConnectFailed)
    expect(ran).toBe(false)
  })

  it("names the address refused and where its URL came from, never the password", async () => {
    const port = await closedPort()
    const attempt = withDatabase(`postgres://u:hunter22@127.0.0.1:${port}/x`, async () => undefined, "--connection")
    await expect(attempt).rejects.toThrow(
      `Could not connect to 127.0.0.1:${port}: the connection was refused, so no Postgres is listening there. ` +
        "Check that the database is running and that --connection names the right host and port",
    )
    await expect(attempt).rejects.not.toThrow("hunter22")
  })
})
