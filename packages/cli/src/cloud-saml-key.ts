/**
 * `supatype sso rotate-key` against a Supatype Cloud project: the two steps self-host takes in `.env`,
 * taken by the control plane, which holds the keys and never hands them out.
 */

import { isBoolean, isOneOf, isRecordOf, isShape, isUnknown, type Guard } from "@supatype/shared"
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

const isAuthView = isShape({ fields: isRecordOf(isShape({ value: isUnknown })) })

/** The SAML check only feeds a warning, so a slow control plane must not hold up the command for long. */
const SAML_CHECK_TIMEOUT_MS = 3_000

/** One call to the linked Cloud environment's auth route, at `/environments/<env>/auth<suffix>`. */
async function environmentAuthCall<T>(
  cwd: string,
  call: { method: string; suffix: string; body?: unknown; timeoutMs?: number },
  guard: Guard<T>,
): Promise<T> {
  const target = resolveTarget(cwd)
  const subpath = `/environments/${encodeURIComponent(target.environment)}/auth${call.suffix}`
  const request = targetRequest(target, { method: call.method, subpath, ...(call.body !== undefined && { body: call.body }) })
  const options = call.timeoutMs === undefined ? request : { ...request, timeoutMs: call.timeoutMs }
  return targetFetch(target.apiBaseUrl, target.apiPrefix, options, guard)
}

/** Whether SAML is on for the linked Cloud project, as the control plane has it from code and Studio together. */
export async function cloudSamlEnabled(cwd: string): Promise<boolean> {
  const view = await environmentAuthCall(cwd, { method: "GET", suffix: "", timeoutMs: SAML_CHECK_TIMEOUT_MS }, isAuthView)
  return view.fields["auth.sso.saml.enabled"]?.value === true
}

/** Take one rotation step on the linked Cloud project, and say what happened. */
export async function rotateCloudSamlKey(cwd: string, promote: boolean): Promise<string> {
  const body = { step: promote ? "promote" : "next" }
  const answer = await environmentAuthCall(cwd, { method: "POST", suffix: "/saml-key", body }, isRotationAnswer)
  const pending = answer.applied ? "" : " The project's auth server picks it up within a minute."
  return SAID[answer.outcome] + pending
}
