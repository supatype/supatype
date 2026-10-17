import { useLocation } from "react-router-dom"
import { pendingSchemaPush, type PendingSchemaPush } from "../lib/migration-outcome.js"
import { useApiQuery } from "./useApiQuery.js"
import { useProjectProxy } from "./useProjectProxy.js"

/**
 * The newest push, while it was refused or failed and no push has applied since; null otherwise.
 *
 * Read through the metadata catalogue Migration History reads through, and asked again on every
 * navigation, so a push that applies clears it on the next click. Null when the history cannot be
 * read: a server from before the query, a role without schema view, or no history yet. None of
 * those is a refused push.
 */
export function usePendingSchemaPush(): PendingSchemaPush | null {
  const proxy = useProjectProxy()
  const { pathname } = useLocation()
  const { data } = useApiQuery(async () => {
    try {
      const result = await proxy.metadata("schema_push_status")
      return pendingSchemaPush(result.rows[0])
    } catch {
      return null
    }
  }, [proxy, pathname])
  return data ?? null
}
