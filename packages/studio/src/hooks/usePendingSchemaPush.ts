import { useLocation } from "react-router-dom"
import { schemaViewOffered } from "../lib/capability-offers.js"
import { pendingSchemaPush, type PendingSchemaPush } from "../lib/migration-outcome.js"
import { useApiQuery } from "./useApiQuery.js"
import { useProjectProxy } from "./useProjectProxy.js"
import { useStudioCapability } from "./useStudioCapability.js"
import { useInterval, useOnReturn } from "./useTabActivity.js"

/**
 * How often the status is asked again while a refusal is on screen. A fixing push applies a few
 * seconds after the file is saved, and the notice says it clears once one does.
 */
export const PENDING_PUSH_POLL_MS = 5_000

/**
 * How often it is asked while nothing is pending, so a push refused while a screen is open shows
 * up on it without a click. Slow, since a refusal is rare and Studio is often left open all day.
 */
export const PENDING_PUSH_IDLE_POLL_MS = 30_000

/**
 * Whether the status may be asked for: once the server has said who the caller is, and only when
 * their role holds schema view, which the server requires of every catalogue query. Asking for
 * anyone else is a refusal on every navigation and every half minute.
 */
function useAsksForPushStatus(): boolean {
  const capability = useStudioCapability()
  return capability.settled && schemaViewOffered(capability)
}

/**
 * The newest push, while it was refused or failed and no push has applied since; null otherwise.
 *
 * Read through the metadata catalogue Migration History reads through, and asked again on every
 * navigation, when the tab comes back, and on a timer that skips a hidden tab: every few seconds
 * while a refusal is showing, so a fixing push clears it, and every half minute otherwise, so a new
 * refusal appears on the screen in front of you. Never asked for a role without schema view. Null
 * when the history cannot be read: a server from before the query, a role without schema view, or
 * no history yet. None of those is a refused push.
 */
export function usePendingSchemaPush(): PendingSchemaPush | null {
  const proxy = useProjectProxy()
  const { pathname } = useLocation()
  const asks = useAsksForPushStatus()
  const { data, refetch } = useApiQuery(async () => {
    if (!asks) return null
    try {
      const result = await proxy.metadata("schema_push_status")
      return pendingSchemaPush(result.rows[0])
    } catch {
      return null
    }
  }, [proxy, pathname, asks])
  const pending = data ?? null
  const pace = pending !== null ? PENDING_PUSH_POLL_MS : PENDING_PUSH_IDLE_POLL_MS
  useInterval(refetch, asks ? pace : null)
  useOnReturn(() => {
    if (asks) refetch()
  })
  return pending
}
