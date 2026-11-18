import type { Server } from "node:http"

/** The port a listening server bound, with the narrowing `address()` needs (it is a string for pipes and null before listen). */
export function portOf(server: Server): number {
  const addr = server.address()
  if (addr === null || typeof addr === "string") throw new Error("server is not listening on a TCP port")
  return addr.port
}
