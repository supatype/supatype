import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"

export function registerStatusRoute(
  routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>,
): void {
  route(routes, "GET", "/projects/:ref/status", async (ctx) => {
    const projectRoot = process.env["SUPATYPE_PROJECT_ROOT"] ?? "/project"
    const functionsRoot = process.env["SUPATYPE_FUNCTIONS_ROOT"] ?? join(projectRoot, "functions")
    const deploymentsDir = process.env["SUPATYPE_DEPLOYMENTS_DIR"] ?? join(projectRoot, ".supatype", "deployments")

    let functions: string[] = []
    if (existsSync(functionsRoot)) {
      functions = readdirSync(functionsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    }

    let deploymentId: string | null = null
    const currentPath = join(deploymentsDir, "current")
    if (existsSync(currentPath)) {
      deploymentId = (await import("node:fs")).readFileSync(currentPath, "utf8").trim()
    }

    sendJson(ctx.res, 200, {
      data: {
        projectRef: process.env["SUPATYPE_PROJECT_REF"] ?? ctx.params["ref"],
        environment: "production",
        functions,
        deploymentId,
        controlPlane: "self-host",
      },
    })
  })
}
