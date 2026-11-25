import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { SiteTarget } from "../../src/site-deploy.js"
import { portOf } from "./ports.js"

/** One request a mock Cloud control plane received, its body read whole. */
export interface SeenRequest {
  method: string
  url: string
  headers: IncomingMessage["headers"]
  body: Buffer
}

export type SiteHandler = (req: SeenRequest, res: ServerResponse) => void

/** A mock control plane: every request is recorded, then `handler` answers it. */
export interface MockSite {
  seen: SeenRequest[]
  base: string
  target: SiteTarget
  close: () => Promise<void>
}

export async function mockSite(handler: SiteHandler): Promise<MockSite> {
  const seen: SeenRequest[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const request: SeenRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) }
      seen.push(request)
      handler(request, res)
    })
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const base = `http://127.0.0.1:${portOf(server)}`
  return {
    seen,
    base,
    target: { apiBaseUrl: base, projectRef: "demo", token: "tok", orgId: "org-1", environment: "production" },
    close: () => new Promise<void>((ok) => void server.close(() => ok())),
  }
}

/** Answer `res` with a JSON body. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}
