import React from "react"
import { Badge, Card } from "../components/ui.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useCacheHealth } from "../hooks/useCacheHealth.js"
import {
  arenaFillPct,
  describeStaleness,
  formatBytes,
  formatPct,
  rowCacheHeadline,
  type Headline,
  type WindowedRate,
} from "../lib/cache-health.js"

/**
 * Is the cache earning its keep, and is it healthy.
 *
 * The browser beside this answers "what is in it", which is management. These three panels are
 * judgement, and every one of them is a number that is easy to render wrongly:
 *
 *   Effectiveness  hit rate over the last interval, because the totals are cumulative
 *   Capacity       arena used against capacity, and evictions, which say the working set does not fit
 *   Row cache      which of five states Mode B is in, and how far behind a read may be
 */

function toneBadge(tone: Headline["tone"]): "green" | "red" | "yellow" | "outline" {
  switch (tone) {
    case "good":
      return "green"
    case "bad":
      return "red"
    case "warn":
      return "yellow"
    default:
      return "outline"
  }
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string | undefined
}): React.ReactElement {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-medium tabular-nums">{value}</div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

/** The window a rate covers, said plainly. An unlabelled percentage is the bug rule 1 is about. */
function windowLabel(rate: WindowedRate): string {
  if (rate.pct === null) {
    return rate.windowMs === 0 ? "waiting for a second reading" : "no reads in the last interval"
  }
  const seconds = Math.round(rate.windowMs / 1000)
  return `${rate.hits + rate.misses} reads in the last ${seconds}s`
}

export function CacheHealthPanels(): React.ReactElement | null {
  const { keyspace, rowCache, recent, rowCacheRecent, loading, error } = useCacheHealth()

  if (error) return <ErrorBanner message={error} />
  if (loading) {
    return <div className="text-sm text-muted-foreground">Reading cache statistics…</div>
  }
  // Neither endpoint had anything: an older server, or a deployment with no database behind it.
  // Nothing to say, and a panel of dashes says it worse than no panel.
  if (!keyspace && !rowCache) return null

  const headline = rowCacheHeadline(rowCache)
  const fill = keyspace ? arenaFillPct(keyspace.arena_used_bytes, keyspace.arena_capacity_bytes) : null

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {keyspace ? (
        <>
          <Card className="p-4 space-y-3">
            <div className="text-sm font-medium">Effectiveness</div>
            <Stat
              label="Hit rate"
              value={formatPct(recent.pct)}
              hint={windowLabel(recent)}
            />
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Entries" value={keyspace.entries.toLocaleString()} />
              {/*
                Labelled "since start", not shown bare. These counters are never reset by reading,
                so a number with no window attached is one a reader will take for recent traffic.
              */}
              <Stat
                label="Hits / misses"
                value={`${keyspace.hits_total.toLocaleString()} / ${keyspace.misses_total.toLocaleString()}`}
                hint="since the cache started"
              />
            </div>
          </Card>

          <Card className="p-4 space-y-3">
            <div className="text-sm font-medium">Capacity</div>
            <Stat
              label="Memory used"
              value={`${formatBytes(keyspace.arena_used_bytes)} / ${formatBytes(keyspace.arena_capacity_bytes)}`}
              hint={fill === null ? undefined : `${fill}% full`}
            />
            <div className="grid grid-cols-2 gap-3">
              <Stat
                label="Evictions"
                value={keyspace.evictions_total.toLocaleString()}
                hint={
                  keyspace.evictions_total > 0
                    ? "entries dropped to make room — the working set is larger than the cache"
                    : "nothing has been dropped to make room"
                }
              />
              <Stat label="Workers" value={`${keyspace.workers} × ${keyspace.partitions}`} />
            </div>
          </Card>
        </>
      ) : null}

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Row cache</div>
          <Badge variant={toneBadge(headline.tone)}>{headline.label}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">{headline.detail}</p>

        {rowCache && rowCache.state !== "unavailable" && rowCache.state !== "off" ? (
          <>
            {/*
              Rule 3: a promise, in words, read live. It grows past the 200ms default once
              participating databases outnumber the invalidation workers, so a hardcoded sentence
              here would understate what is being promised.
            */}
            <p className="text-xs text-muted-foreground">{describeStaleness(rowCache.stale_after_ms)}</p>
            <div className="grid grid-cols-2 gap-3">
              <Stat
                label="Hit rate"
                value={formatPct(rowCacheRecent.pct)}
                hint={windowLabel(rowCacheRecent)}
              />
              <Stat label="Cached rows" value={rowCache.entries.toLocaleString()} />
            </div>
            {rowCache.incoherent_databases > 0 ? (
              <p className="text-xs text-red-400">
                {rowCache.incoherent_databases} of {rowCache.participating_databases} databases are not
                current; their reads are being served from the heap.
              </p>
            ) : null}
          </>
        ) : null}
      </Card>
    </div>
  )
}
