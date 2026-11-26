import { createContext, useContext, useEffect, useState } from "react"
import type { SupatypeClient } from "@supatype/client"
import { type Guard, isArrayOf, isNumber, isShape, isString, readJson } from "./json.js"
import { studioRestHeaders } from "./studio-auth-headers.js"

/**
 * Where the Dashboard's Database Size and Storage cards get their figures.
 *
 * Studio takes a source from its host, as it takes the connection and the static site host.
 * Without one it reads `db_stats()` and `storage_stats()` from the project's own `supatype` schema,
 * which is right on a self-host stack. Cloud does not expose that schema, so its host passes a
 * source that reads the platform's metered usage instead.
 */

/** One measured size: bytes in use, and the plan's limit in bytes when there is one. */
export interface SizeFigure {
  usedBytes: number
  limitBytes: number | null
}

/** What both cards render from. A figure is null when the source cannot say. */
export interface SizeReadout {
  db: SizeFigure | null
  storage: SizeFigure | null
  /** Files in storage, when the source counts them. */
  fileCount: number | null
}

export interface SizeSource {
  read(signal: AbortSignal): Promise<SizeReadout>
}

export const SizeSourceCtx = createContext<SizeSource | undefined>(undefined)

/** `storage_stats()`: `RETURNS TABLE(file_count BIGINT, total_bytes BIGINT)`, both never null. */
const isStorageStats = isArrayOf(isShape({ file_count: isNumber, total_bytes: isNumber }))

/** `db_stats()`: `RETURNS TABLE(db_size_bytes BIGINT, db_size_pretty TEXT)`. */
const isDbStats = isArrayOf(isShape({ db_size_bytes: isNumber, db_size_pretty: isString }))

async function callStatsRpc<T>(client: SupatypeClient, name: string, guard: Guard<T>, signal: AbortSignal): Promise<T | null> {
  const res = await fetch(`${client.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    signal,
    headers: studioRestHeaders(client, {
      "Content-Profile": "supatype",
      "Accept-Profile": "supatype",
      "Content-Type": "application/json",
    }),
    body: "{}",
  })
  return res.ok ? readJson(res, guard) : null
}

/** The default source: the project's own `db_stats` and `storage_stats` functions. */
export function rpcSizeSource(client: SupatypeClient): SizeSource {
  return {
    async read(signal) {
      const [db, storage] = await Promise.all([
        callStatsRpc(client, "db_stats", isDbStats, signal).catch(() => null),
        callStatsRpc(client, "storage_stats", isStorageStats, signal).catch(() => null),
      ])
      const dbRow = db?.[0]
      const storageRow = storage?.[0]
      return {
        db: dbRow ? { usedBytes: dbRow.db_size_bytes, limitBytes: null } : null,
        storage: storageRow ? { usedBytes: storageRow.total_bytes, limitBytes: null } : null,
        fileCount: storageRow ? storageRow.file_count : null,
      }
    },
  }
}

/** Reads the source once per client and source; null until it answers, and still null if it fails. */
export function useSizeReadout(client: SupatypeClient): { readout: SizeReadout | null; settled: boolean } {
  const hosted = useContext(SizeSourceCtx)
  const [state, setState] = useState<{ readout: SizeReadout | null; settled: boolean }>({ readout: null, settled: false })
  useEffect(() => {
    const abort = new AbortController()
    const source = hosted ?? rpcSizeSource(client)
    source.read(abort.signal).then(
      (readout) => { if (!abort.signal.aborted) setState({ readout, settled: true }) },
      () => { if (!abort.signal.aborted) setState({ readout: null, settled: true }) },
    )
    return () => abort.abort()
  }, [client, hosted])
  return state
}

const BYTES_PER_MB = 1024 * 1024

/** A usage figure in MB, as the Cloud control plane meters it, as bytes. */
export function megabytesToFigure(used: number, limit: number | null): SizeFigure {
  return { usedBytes: used * BYTES_PER_MB, limitBytes: limit === null ? null : limit * BYTES_PER_MB }
}
