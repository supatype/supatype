/**
 * `api.corsOrigins` for a Supatype Cloud project.
 *
 * Self-host reads the list as `SUPATYPE_CORS_ALLOW_ORIGINS`, written from the config. A Cloud project
 * keeps its list in the project's own database behind `PUT /projects/:slug/cors-origins`, which
 * Studio edits too, so a push sends the config's list there. The config wins: a list saved in Studio
 * is replaced by the config's on the next push. A config that does not set `api.corsOrigins` says
 * nothing about the list, and the push leaves it as it is.
 */

import type { SupatypeProjectConfig } from "./project-config.js"
import type { DeployTarget } from "./resolve-target.js"
import { errorMessage } from "./error-message.js"
import { postApplyFailed } from "./post-apply.js"
import { targetFetch } from "./target-client.js"
import { targetRequest } from "./target-request.js"
import { info } from "./ui/messages.js"

/** The origins a push sends to `target`, or undefined when it sends none (not Cloud, or nothing set). */
export function corsOriginsToPush(target: Pick<DeployTarget, "mode">, config: SupatypeProjectConfig): string[] | undefined {
  if (target.mode !== "cloud") return undefined
  const origins = config.api?.corsOrigins
  return origins === undefined ? undefined : origins.map((origin) => origin.trim()).filter((origin) => origin !== "")
}

/** Send the config's allowed origins to a Cloud target. Returns true when the step failed (post-apply.ts). */
export async function pushCorsOrigins(target: DeployTarget, config: SupatypeProjectConfig): Promise<boolean> {
  const origins = corsOriginsToPush(target, config)
  if (origins === undefined) return false
  try {
    await targetFetch(target.apiBaseUrl, target.apiPrefix, targetRequest(target, { method: "PUT", subpath: "/cors-origins", body: { origins } }))
  } catch (err) {
    postApplyFailed(
      `its allowed origins (api.corsOrigins) were not saved on ${target.apiBaseUrl}: ${errorMessage(err)}`,
      "The project keeps the origins it allowed before.",
    )
    return true
  }
  info(origins.length === 0 ? "Allowed origins cleared (api.corsOrigins is empty)" : `Allowed origins set from api.corsOrigins: ${origins.join(", ")}`)
  return false
}
