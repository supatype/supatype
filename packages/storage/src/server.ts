import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse } from "node:http"
import { authenticate, isServiceRole, type JwtPayload } from "./auth.js"
import { ensureSchema } from "./db.js"
import * as bucketRoutes from "./routes/buckets.js"
import * as objectRoutes from "./routes/objects.js"
import { getDefaultCorsHeaders } from "./middleware/cors.js"

export interface RequestContext {
  req: IncomingMessage
  res: ServerResponse
  jwt: JwtPayload | null
  params: Record<string, string>
  url: URL
}

type RouteHandler = (ctx: RequestContext) => Promise<void>

interface Route {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: RouteHandler
  requireAuth: boolean
  requireServiceRole: boolean
}

const routes: Route[] = []

export function route(
  method: string,
  path: string,
  handler: RouteHandler,
  opts?: { requireAuth?: boolean; requireServiceRole?: boolean },
): void {
  const paramNames: string[] = []
  const pattern = new RegExp(
    "^" +
      path.replace(/:([a-zA-Z_]+)/g, (_, name: string) => {
        paramNames.push(name)
        return "([^/]+)"
      }).replace(/\*\*/g, () => {
        paramNames.push("wildcard")
        return "(.*)"
      }) +
      "$",
  )
  routes.push({
    method: method.toUpperCase(),
    pattern,
    paramNames,
    handler,
    requireAuth: opts?.requireAuth ?? false,
    requireServiceRole: opts?.requireServiceRole ?? false,
  })
}

function matchRoute(
  method: string,
  pathname: string,
): { handler: RouteHandler; params: Record<string, string>; route: Route } | null {
  for (const r of routes) {
    if (r.method !== method && r.method !== "*") continue
    const m = pathname.match(r.pattern)
    if (m) {
      const params: Record<string, string> = {}
      r.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]!)
      })
      return { handler: r.handler, params, route: r }
    }
  }
  return null
}

// ─── Register routes ────────────────────────────────────────────────────────────

// Bucket routes (all require service_role)
route("GET", "/bucket", bucketRoutes.list, { requireServiceRole: true })
route("POST", "/bucket", bucketRoutes.create, { requireServiceRole: true })
route("GET", "/bucket/:id", bucketRoutes.get, { requireServiceRole: true })
route("PUT", "/bucket/:id", bucketRoutes.update, { requireServiceRole: true })
route("DELETE", "/bucket/:id", bucketRoutes.remove, { requireServiceRole: true })
route("POST", "/bucket/:id/empty", bucketRoutes.empty, { requireServiceRole: true })

// Object routes
route("POST", "/object/:bucket/**", objectRoutes.upload, { requireAuth: true })
route("GET", "/object/public/:bucket/**", objectRoutes.downloadPublic)
route("GET", "/object/authenticated/:bucket/**", objectRoutes.downloadAuthenticated, { requireAuth: true })
route("GET", "/object/sign/:bucket/**", objectRoutes.downloadSigned)
route("DELETE", "/object/:bucket", objectRoutes.removeObjects, { requireAuth: true })
route("POST", "/object/list/:bucket", objectRoutes.listObjects, { requireAuth: true })

// Pre-signed URL
route("POST", "/object/sign/:bucket/**", objectRoutes.createSignedUrl, { requireAuth: true })

// ─── Server ─────────────────────────────────────────────────────────────────────

export function createServer() {
  let schemaReady = false

  ensureSchema()
    .then(() => {
      schemaReady = true
      console.log("storage schema ready")
    })
    .catch((err) => {
      console.error("Failed to ensure storage schema:", err)
      process.exit(1)
    })

  return httpCreateServer(async (req, res) => {
    // Health check
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: schemaReady ? "ok" : "starting" }))
      return
    }

    if (!schemaReady) {
      sendJson(res, 503, { error: "Storage service starting" })
      return
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    const method = req.method?.toUpperCase() ?? "GET"

    // CORS preflight — use default (permissive) headers since we don't
    // know the bucket yet during OPTIONS. Per-bucket CORS is applied by
    // each route handler after resolving the bucket.
    if (method === "OPTIONS") {
      res.writeHead(204, getDefaultCorsHeaders())
      res.end()
      return
    }

    const matched = matchRoute(method, url.pathname)
    if (!matched) {
      sendJson(res, 404, { error: "Not found" })
      return
    }

    const jwt = authenticate(req)

    if (matched.route.requireServiceRole && !isServiceRole(jwt)) {
      sendJson(res, 403, { error: "Forbidden: service_role required" })
      return
    }

    if (matched.route.requireAuth && jwt === null) {
      sendJson(res, 401, { error: "Unauthorized" })
      return
    }

    try {
      // Default CORS headers — route handlers may override with
      // bucket-specific headers via applyCorsHeaders()
      for (const [k, v] of Object.entries(getDefaultCorsHeaders())) {
        res.setHeader(k, v)
      }
      await matched.handler({ req, res, jwt, params: matched.params, url })
    } catch (err) {
      console.error("Unhandled error:", err)
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" })
      }
    }
  })
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return Buffer.concat(chunks)
}

export async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const buf = await readBody(req)
  return JSON.parse(buf.toString("utf8")) as T
}

// CORS headers are now managed by middleware/cors.ts
// See getDefaultCorsHeaders() and applyCorsHeaders()
