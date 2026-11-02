import { isJsonObject, isString } from "@supatype/shared"
import { warn } from "./ui/messages.js"

/**
 * Says the warning a target answered a call with, when it gave one. A self-hosted control plane
 * that could not reach Docker, when the call needed nothing restarted, answers with one rather than
 * failing: the call did what it was asked, and the person should know the stack's Docker is down.
 */
export function sayTargetWarning(answer: unknown): void {
  if (isJsonObject(answer) && isString(answer["warning"])) warn(answer["warning"])
}
