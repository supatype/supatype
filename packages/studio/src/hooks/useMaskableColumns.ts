import { useEffect, useState } from "react"
import { useAdminClient } from "./useAdminClient.js"

/**
 * The columns of `table` that a REST response says may be masked (`X-Supatype-Masked-Fields`), read
 * only while `enabled`: when Studio has no field access answer of its own and needs a second source
 * for which nulls may be withheld values. Empty until it arrives, and when the header is absent.
 */
export function useMaskableColumns(table: string, enabled: boolean): string[] {
  const client = useAdminClient()
  // Kept with the table they were read for, so another model never shows this one's columns.
  const [read, setRead] = useState<{ table: string; columns: string[] }>({ table: "", columns: [] })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      try {
        const result = await client.from(table).select().limit(0)
        if (!cancelled) setRead({ table, columns: (result.meta?.maskedFields ?? []).map((m) => m.column) })
      } catch {
        // No second source either: nothing more is known, and the server still refuses what it should.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, table, enabled])

  return enabled && read.table === table ? read.columns : []
}
