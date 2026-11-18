/**
 * `supatype sso rotate-key` against a Supatype Cloud project: the two steps self-host takes in `.env`,
 * taken by the control plane, which holds the keys and never hands them out.
 */

import { isBoolean, isOneOf, isShape } from "@supatype/shared"
import { resolveTarget } from "./resolve-target.js"
import { targetFetch } from "./target-client.js"
import { targetRequest } from "./target-request.js"

const isRotationAnswer = isShape({
  outcome: isOneOf(["created", "exists", "promoted", "no-next-key"] as const),
  applied: isBoolean,
})

/** What one step said, in words for the terminal. */
const SAID: Record<"created" | "exists" | "promoted" | "no-next-key", string> = {
  created:
    "Made a next SAML signing key beside the current one. The project's service provider metadata now " +
    "lists both certificates: give each identity provider the new one, then run `supatype sso rotate-key --promote`.",
  exists: "A next SAML signing key is already waiting; kept it. Run `supatype sso rotate-key --promote` once every identity provider has its certificate.",
  promoted: "The next SAML signing key is now the current one.",
  "no-next-key": "There is no next SAML signing key to promote. Run `supatype sso rotate-key` first.",
}

/** Take one rotation step on the linked Cloud project, and say what happened. */
export async function rotateCloudSamlKey(cwd: string, promote: boolean): Promise<string> {
  const target = resolveTarget(cwd)
  const answer = await targetFetch(
    target.apiBaseUrl,
    target.apiPrefix,
    targetRequest(target, {
      method: "POST",
      subpath: `/environments/${encodeURIComponent(target.environment)}/auth/saml-key`,
      body: { step: promote ? "promote" : "next" },
    }),
    isRotationAnswer,
  )
  const pending = answer.applied ? "" : " The project's auth server picks it up within a minute."
  return SAID[answer.outcome] + pending
}
