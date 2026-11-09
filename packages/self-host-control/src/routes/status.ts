import { route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"
import { assertProject } from "../project.js"
import { functionsRoot } from "../worker.js"
import { currentLiveId } from "./deployments.js"
import { servedFunctions } from "./functions.js"

export function registerStatusRoute(
  routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>,
): void {
  route(routes, "GET", "/projects/:ref/status", async (ctx) => {
    // Every other route refuses another project's ref; this one used to answer it as its own.
    assertProject(ctx.params["ref"]!)
    sendJson(ctx.res, 200, {
      data: {
        projectRef: ctx.params["ref"],
        environment: "production",
        // What the worker serves, as the functions list route answers: every directory under the
        // root was listed, `_shared` among them (issue 79).
        functions: servedFunctions(functionsRoot()),
        deploymentId: currentLiveId(),
        controlPlane: "self-host",
      },
    })
  })
}
