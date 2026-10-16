import type { IncomingMessage, ServerResponse } from "node:http"

export type RouteHandler = (ctx: {
  req: IncomingMessage
  res: ServerResponse
  params: Record<string, string>
  body: unknown
  pathname: string
}) => void | Promise<void>

/** A refusal a handler throws, answered by the server with this status and error code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "HttpError"
  }
}

/** A 400 for a request whose input fails validation. */
export function badRequest(message: string): HttpError {
  return new HttpError(400, "validation_error", message)
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(payload))
}

export function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: unknown) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))))
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        reject(badRequest("Invalid JSON body"))
      }
    })
    req.on("error", reject)
  })
}

export function matchRoute(
  routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>,
  method: string,
  pathname: string,
): { handler: RouteHandler; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue
    const m = pathname.match(route.pattern)
    if (!m) continue
    const params: Record<string, string> = {}
    if (m.groups) {
      for (const [k, v] of Object.entries(m.groups)) {
        if (v !== undefined) params[k] = v
      }
    }
    return { handler: route.handler, params }
  }
  return null
}

export function route(
  routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>,
  method: string,
  pathPattern: string,
  handler: RouteHandler,
): void {
  const pattern = new RegExp(
    `^${pathPattern.replace(/:(\w+)/g, (_, name) => `(?<${name}>[^/]+)`)}$`,
  )
  routes.push({ method, pattern, handler })
}
