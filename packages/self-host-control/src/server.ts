import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { readBody, sendJson, matchRoute, type RouteHandler } from "./http.js"
import { registerSchemaRoutes } from "./routes/schema.js"
import { registerFunctionRoutes } from "./routes/functions.js"
import { registerDeploymentRoutes } from "./routes/deployments.js"
import { registerStatusRoute } from "./routes/status.js"

const routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }> = []

registerSchemaRoutes(routes)
registerFunctionRoutes(routes)
registerDeploymentRoutes(routes)
registerStatusRoute(routes)

export function createControlPlaneServer(): ReturnType<typeof createServer> {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      })
      res.end()
      return
    }

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
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: "internal_error", message })
    }
  })
}

const port = parseInt(process.env["PORT"] ?? "8080", 10)
const isMainEntry = process.argv[1]
  ? fileURLToPath(pathToFileURL(resolve(process.argv[1]))) === fileURLToPath(import.meta.url)
  : false
if (isMainEntry) {
  createControlPlaneServer().listen(port, "0.0.0.0", () => {
    console.log(`[control-plane] listening on :${port}`)
  })
}
