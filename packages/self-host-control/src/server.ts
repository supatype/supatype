import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { HttpError, readBody, sendJson, matchRoute, type RouteHandler } from "./http.js"
import { registerSchemaRoutes } from "./routes/schema.js"
import { registerFunctionRoutes } from "./routes/functions.js"
import { registerDeploymentRoutes } from "./routes/deployments.js"
import { registerStatusRoute } from "./routes/status.js"
import { CONTROL_PLANE_SECRET_ENV, controlPlaneSecretFromEnv, secretCheck } from "./auth.js"

const routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }> = []

registerSchemaRoutes(routes)
registerFunctionRoutes(routes)
registerDeploymentRoutes(routes)
registerStatusRoute(routes)

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

const port = parseInt(process.env["PORT"] ?? "8080", 10)
const isMainEntry = process.argv[1]
  ? fileURLToPath(pathToFileURL(resolve(process.argv[1]))) === fileURLToPath(import.meta.url)
  : false
if (isMainEntry) {
  // Refuses to start rather than starting into a state where it answers nobody: a stack missing
  // the variable is a setup mistake, and an exit says so where a wall of 401s would not.
  const secret = controlPlaneSecretFromEnv()
  if (secret === "") {
    console.error(`[control-plane] ${CONTROL_PLANE_SECRET_ENV} is not set; refusing to start`)
    process.exit(1)
  }
  createControlPlaneServer(secret).listen(port, "0.0.0.0", () => {
    console.log(`[control-plane] listening on :${port}`)
  })
}
