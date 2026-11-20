import type { IncomingMessage, ServerResponse } from "node:http"
import type { Guard } from "@supatype/shared"

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

/**
 * A request body as the route reads it: an object whose keys have the types the guard names. A body
 * that is not one (an array, a string, a key of the wrong type) is a 400, never a 500 from deep in
 * the handler.
 */
export function bodyOf<T>(body: unknown, guard: Guard<T>): T {
  if (!guard(body)) throw badRequest("Request body does not have the fields this route reads, with their types")
  return body
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(payload))
}

/** A 413 for a request body over the route's byte cap. */
export function payloadTooLarge(maxBytes: number): HttpError {
  return new HttpError(413, "payload_too_large", `The request body is over the ${maxBytes} byte limit for this route.`)
}

/**
 * The request body, parsed. With `maxBytes` the read is bounded: a declared length over it, or a
 * body that grows past it, is refused as soon as that is known, and nothing more is kept in memory.
 */
export function readBody(req: IncomingMessage, maxBytes?: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let refused = false
    const refuse = (): void => {
      refused = true
      chunks.length = 0
      reject(payloadTooLarge(maxBytes ?? 0))
    }
    if (maxBytes !== undefined && Number(req.headers["content-length"] ?? 0) > maxBytes) refuse()
    req.on("data", (c: unknown) => {
      if (refused) return
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(String(c))
      size += chunk.length
      if (maxBytes !== undefined && size > maxBytes) refuse()
      else chunks.push(chunk)
    })
    req.on("end", () => {
      if (refused) return
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

/** The byte cap a route set for its body, by handler. A route with none reads any size, as before. */
const bodyLimits = new WeakMap<RouteHandler, number>()

export function matchRoute(
  routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>,
  method: string,
  pathname: string,
): { handler: RouteHandler; params: Record<string, string>; maxBodyBytes?: number } | null {
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
    const maxBodyBytes = bodyLimits.get(route.handler)
    return { handler: route.handler, params, ...(maxBodyBytes !== undefined && { maxBodyBytes }) }
  }
  return null
}

export function route(
  routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>,
  method: string,
  pathPattern: string,
  handler: RouteHandler,
  options: { maxBodyBytes?: number } = {},
): void {
  if (options.maxBodyBytes !== undefined) bodyLimits.set(handler, options.maxBodyBytes)
  const pattern = new RegExp(
    `^${pathPattern.replace(/:(\w+)/g, (_, name) => `(?<${name}>[^/]+)`)}$`,
  )
  routes.push({ method, pattern, handler })
}
