import { createServer, type Server } from "node:net"

/** The port a listening server took. */
export function portOf(server: Pick<Server, "address">): number {
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("the server is not listening on a port")
  return address.port
}

/** A port on 127.0.0.1 nothing listens on, as the system handed it out a moment ago. */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const port = portOf(server)
  await new Promise((done) => server.close(done))
  return port
}
