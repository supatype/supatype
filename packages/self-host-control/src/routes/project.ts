import { route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"
import { projectRef } from "../project.js"

/**
 * `GET /project`: the ref this control plane serves.
 *
 * Self-host Studio is mounted without a project ref (Cloud's knows its own), and every other route
 * here is addressed by one, so Studio asks once.
 */
export function registerProjectRoute(
  routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>,
): void {
  route(routes, "GET", "/project", (ctx) => {
    sendJson(ctx.res, 200, { data: { ref: projectRef() } })
  })
}
