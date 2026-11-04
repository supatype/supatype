/**
 * What the running server says about after-hooks, from `components.after_hooks` on its `/health`.
 *
 * The server's change-log listener knows which path after-hooks take, which replica reads the slot,
 * how much WAL the slot holds and what last went wrong. Reading that beats probing the database
 * from here: it is the answer of the process that actually delivers the hooks, as the role it
 * connects with, which `doctor`'s own connection may not share.
 */
import { isNumber, isOneOf, isRecordOf, isShape, isString, isUnknown, optional, type Guard } from "@supatype/shared"
import { gibibytes, REQUEST_PATH_IMPACT, RETAINED_WAL_WARN_BYTES } from "./db-preflight.js"
import { fetchWithin } from "./fetch-within.js"

/** Where doctor sends someone whose after-hooks are on the request path. */
export const DB_CHECK_HINT = "  See what to change with: supatype db check"

/** `components.after_hooks`, as the server's `changelog.Status` writes it. */
export interface AfterHooksHealth {
  path: "changelog" | "request" | "unknown"
  slot: string
  reason?: string
  role?: string
  retained_wal_bytes?: number
  last_error?: string
}

const isAfterHooksHealth: Guard<AfterHooksHealth> = isShape({
  path: isOneOf(["changelog", "request", "unknown"]),
  slot: isString,
  reason: optional(isString),
  role: optional(isString),
  retained_wal_bytes: optional(isNumber),
  last_error: optional(isString),
})

const isHealthBody = isShape({ components: optional(isRecordOf(isUnknown)) })

/**
 * The server's after-hook status from the stack at `stackUrl`, or undefined when nothing answers,
 * the answer is not JSON, or the server predates the listener and reports no `after_hooks`.
 */
export async function readAfterHooksHealth(stackUrl: string): Promise<AfterHooksHealth | undefined> {
  try {
    const res = await fetchWithin(`${stackUrl.replace(/\/$/, "")}/health`, 2_000)
    if (!res.ok) return undefined
    const body: unknown = await res.json()
    const component = isHealthBody(body) ? body.components?.["after_hooks"] : undefined
    return isAfterHooksHealth(component) ? component : undefined
  } catch {
    // Unreachable or unreadable: the caller asks the database instead.
    return undefined
  }
}

/** Doctor's lines for the server's answer: the path, why, and anything worth acting on. */
export function afterHooksHealthLines(health: AfterHooksHealth): string[] {
  return [...pathLines(health), ...troubleLines(health)]
}

function pathLines(health: AfterHooksHealth): string[] {
  if (health.path === "changelog") {
    const role = health.role === undefined ? "" : `, this replica the ${health.role}`
    return [`  • change log (slot ${health.slot}${role}): afterChange and afterDelete see every writer.`]
  }
  if (health.path === "unknown") {
    return [`  The server has not decided yet${health.reason === undefined ? "" : `: ${health.reason}`}.`]
  }
  return [
    `  ✗ request path${health.reason === undefined ? "" : `, because ${health.reason}`}.`,
    `  ${REQUEST_PATH_IMPACT}`,
    DB_CHECK_HINT,
  ]
}

function troubleLines(health: AfterHooksHealth): string[] {
  const lines: string[] = []
  const retained = health.retained_wal_bytes ?? 0
  if (retained > RETAINED_WAL_WARN_BYTES) {
    lines.push(
      `  ✗ slot ${health.slot} holds ${gibibytes(retained)} of WAL: hook delivery is behind. Postgres drops a`,
      "    slot at max_slot_wal_keep_size, and changes it had not delivered are then never delivered.",
    )
  }
  if (health.last_error !== undefined) lines.push(`  Last error: ${health.last_error}`)
  return lines
}
