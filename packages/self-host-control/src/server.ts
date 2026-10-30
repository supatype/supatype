import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { HttpError, readBody, sendJson, matchRoute, type RouteHandler } from "./http.js"
import { registerSchemaRoutes } from "./routes/schema.js"
import { registerFunctionRoutes } from "./routes/functions.js"
import { registerDeploymentRoutes } from "./routes/deployments.js"
import { registerStatusRoute } from "./routes/status.js"
import { registerRealtimeRoutes } from "./routes/realtime.js"
import { registerProjectRoute } from "./routes/project.js"
import { secretCheck } from "./auth.js"

const routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }> = []

registerSchemaRoutes(routes)
registerFunctionRoutes(routes)
registerDeploymentRoutes(routes)
registerStatusRoute(routes)
registerRealtimeRoutes(routes)
registerProjectRoute(routes)

/**
 * The control plane's HTTP server, answering only requests that present `secret`.
 *
 * Checked before anything else, preflight and unknown paths included, so a caller without the
 * secret learns nothing about what is here. See `auth.ts` for why the gateway alone holds it.
 */
export function createControlPlaneServer(secret: string): ReturnType<typeof createServer> {
  const presentsSecret = secretCheck(secret)
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!presentsSecret(req)) {
      sendJson(res, 401, { error: "unauthorized", message: "Control plane requests must come through the gateway" })
      return
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      })
      res.end()
      return
    }

    await dispatch(req, res)
  })
}

/** Route an authenticated request to its handler, answering its errors as JSON. */
async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const matched = matchRoute(routes, req.method ?? "GET", url.pathname)
  if (!matched) {
    sendJson(res, 404, { error: "not_found", message: "Route not found" })
    return
  }

  try {
    const body = await readBody(req)
    await matched.handler({
      req,
      res,
      params: matched.params,
      body,
      pathname: url.pathname,
    })
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.code, message: err.message })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    sendJson(res, 500, { error: "internal_error", message })
  }
}
