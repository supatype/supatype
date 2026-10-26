import { useCallback, useEffect, useRef, useState } from "react"
import type { StorageListEntry, SupatypeClient } from "@supatype/client"

/**
 * A folder's direct children, searched by the storage server, read a page at a time with more
 * loaded on request.
 *
 * The storage list route (packages/storage/src/routes/objects.ts) answers a folder's subfolders and
 * objects, 100 at a time unless asked otherwise, takes `offset` for the next ones and `search` for a
 * name, and counts every match in X-Total-Count. Studio's file views read one page and stopped, and
 * searched only that page in the browser, so a bigger folder hid the rest of its files.
 */

/** Entries per page: the storage server's own default. */
export const STORAGE_PAGE_SIZE = 100

/** Which folder to list, and the name to search it for ("" for everything). */
export interface StorageListQuery {
  bucket: string | null
  prefix: string
  search: string
}

export interface StorageListing {
  /** Every entry loaded so far: subfolders, then objects, each named relative to the folder. */
  items: StorageListEntry[]
  /** How many entries match in all, or null when the server does not say. */
  total: number | null
  /** Reading the folder from its first page, which replaces what is listed. */
  loading: boolean
  /** Reading a further page, which adds to what is listed. */
  loadingMore: boolean
  error: string | null
  /** Whether the server holds entries past those loaded. */
  more: boolean
  loadMore: () => void
  /** Reads the folder again from its first page. */
  reload: () => void
}

interface ListState {
  items: StorageListEntry[]
  total: number | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  more: boolean
}

const START: ListState = { items: [], total: null, loading: true, loadingMore: false, error: null, more: false }

type PageAnswer = { page: StorageListEntry[]; total: number | null } | { error: string }

/** One page of the folder, or why it could not be read. */
async function listPage(client: SupatypeClient, query: StorageListQuery & { bucket: string }, at: { offset: number; limit: number }): Promise<PageAnswer> {
  try {
    const options = { limit: at.limit, offset: at.offset, ...(query.search !== "" && { search: query.search }) }
    const { data, count, error } = await client.storage.from(query.bucket).list(query.prefix || undefined, options)
    return error ? { error: error.message } : { page: data ?? [], total: count }
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** The state after a page arrived at `offset`. */
function withPage(s: ListState, offset: number, answer: { page: StorageListEntry[]; total: number | null }, pageSize: number): ListState {
  const items = offset === 0 ? answer.page : [...s.items, ...answer.page]
  // Without a total, a full page is the only sign of more.
  const more = answer.total === null ? answer.page.length === pageSize : items.length < answer.total
  return { items, total: answer.total, loading: false, loadingMore: false, error: null, more }
}

/** The entries of `query.prefix` in `query.bucket` (nothing while it is null), a page at a time. */
export function useStorageList(client: SupatypeClient, query: StorageListQuery, pageSize = STORAGE_PAGE_SIZE): StorageListing {
  const { bucket, prefix, search } = query
  const [state, setState] = useState<ListState>(START)
  const latest = useRef(0)

  const load = useCallback(async (offset: number) => {
    const request = ++latest.current
    if (bucket === null) return setState({ ...START, loading: false })
    setState((s) => ({ ...s, loading: offset === 0, loadingMore: offset > 0, error: null }))
    const answer = await listPage(client, { bucket, prefix, search }, { offset, limit: pageSize })
    // A newer read (another folder, another search, or a reload) replaces this one.
    if (request !== latest.current) return
    if ("error" in answer) return setState((s) => ({ ...s, loading: false, loadingMore: false, error: answer.error }))
    setState((s) => withPage(s, offset, answer, pageSize))
  }, [client, bucket, prefix, search, pageSize])

  useEffect(() => { void load(0) }, [load])

  const loadMore = useCallback(() => { void load(state.items.length) }, [load, state.items.length])
  const reload = useCallback(() => { void load(0) }, [load])
  return { ...state, loadMore, reload }
}

/** "100 of 150": how many entries are listed of how many match, or just the count without a total. */
export function listedOfTotal(listing: Pick<StorageListing, "items" | "total">): string {
  return listing.total === null ? `${listing.items.length}` : `${listing.items.length} of ${listing.total}`
}
