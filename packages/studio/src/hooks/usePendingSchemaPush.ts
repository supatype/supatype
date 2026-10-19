import { useEffect } from "react"
import { useLocation } from "react-router-dom"
import { pendingSchemaPush, type PendingSchemaPush } from "../lib/migration-outcome.js"
import { useApiQuery } from "./useApiQuery.js"
import { useProjectProxy } from "./useProjectProxy.js"

/**
 * How often the status is asked again while a refusal is on screen. A fixing push applies a few
 * seconds after the file is saved, and the notice says it clears once one does.
 */
export const PENDING_PUSH_POLL_MS = 5_000

/**
 * The newest push, while it was refused or failed and no push has applied since; null otherwise.
 *
 * Read through the metadata catalogue Migration History reads through, and asked again on every
 * navigation and, while a refusal is showing, every few seconds: it used to be asked only on
 * navigation, so a push that fixed the schema left the notice up until the next click. Null when
 * the history cannot be read: a server from before the query, a role without schema view, or no
 * history yet. None of those is a refused push.
 */
export function usePendingSchemaPush(): PendingSchemaPush | null {
  const proxy = useProjectProxy()
  const { pathname } = useLocation()
  const { data, refetch } = useApiQuery(async () => {
    try {
      const result = await proxy.metadata("schema_push_status")
      return pendingSchemaPush(result.rows[0])
    } catch {
      return null
    }
  }, [proxy, pathname])
  const pending = data ?? null
  const showing = pending !== null
  useEffect(() => {
    if (!showing) return
    const id = setInterval(() => refetch(), PENDING_PUSH_POLL_MS)
    return () => clearInterval(id)
  }, [showing, refetch])
  return pending
}
