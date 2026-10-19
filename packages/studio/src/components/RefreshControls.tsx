import React from "react"
import { AUTO_REFRESH_CHOICES, type ListFreshness } from "../hooks/useListFreshness.js"
import { Button, Select } from "./ui.js"

const OFF = "off"

/**
 * A list's Refresh button and its auto-refresh menu, driven by {@link useListFreshness}.
 *
 * One component for every list so they offer the same choices in the same place. `busy` dims the
 * button while a fetch is in flight, so a second press does not queue a second request.
 */
export function RefreshControls({ freshness, busy = false }: { freshness: ListFreshness; busy?: boolean }): React.ReactElement {
  const { refresh, autoRefreshMs, setAutoRefreshMs } = freshness
  return (
    <>
      <Button size="sm" onClick={refresh} disabled={busy} title="Fetch the rows again">
        Refresh
      </Button>
      <Select
        aria-label="Auto-refresh"
        className="w-[96px] py-1 text-xs"
        value={autoRefreshMs === null ? OFF : String(autoRefreshMs)}
        onChange={(e) => { setAutoRefreshMs(e.target.value === OFF ? null : Number(e.target.value)) }}
      >
        {AUTO_REFRESH_CHOICES.map((c) => (
          <option key={c.label} value={c.ms === null ? OFF : String(c.ms)}>
            Auto: {c.label}
          </option>
        ))}
      </Select>
    </>
  )
}
