/**
 * 0.9.2 release test (N-FF9): React, Vue and Solid showed `loading: false, data: null` on the
 * render where an enabled query started, which an app reads as "done, nothing found". Svelte's
 * `loading` store starts at false too, but no subscriber ever sees it so for an enabled query: the
 * read starts while `createQuery` runs, before anything can subscribe, and when the options store
 * turns the query on, `loading` is set before a page subscribed to both stores hears of either.
 * These hold that, so a read moved later (to a mount hook, say) cannot bring the bug here.
 *
 * Every read is held unanswered, so what is recorded is what a page shows while it waits.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { derived, writable, type Readable } from "svelte/store"
import { createClient, type AnyDatabase, type SupatypeClient } from "@supatype/client"

const lifecycle = vi.hoisted(() => ({
  destroy: [] as Array<() => void>,
  client: null as SupatypeClient<AnyDatabase> | null,
}))

vi.mock("svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("svelte")>()),
  onDestroy: (fn: () => void) => lifecycle.destroy.push(fn),
}))

vi.mock("../src/context.js", () => ({
  getSupatypeClient: () => lifecycle.client,
}))

import { createQuery, type QueryOptions, type QueryStore } from "../src/createQuery.js"

/** What a page shows at one moment: the options it asked with, and the query's state. */
interface Shown {
  enabled: boolean
  loading: boolean
  data: unknown[] | null
}

/** Every state a page subscribed to `query` (and to `options`, when a store) is shown, in order. */
function record(query: QueryStore<unknown>, options: Readable<QueryOptions>): Shown[] {
  const seen: Shown[] = []
  const shown = derived([options, query.loading, query.data], ([o, loading, data]) => ({
    enabled: o.enabled !== false,
    loading,
    data,
  }))
  lifecycle.destroy.push(shown.subscribe((s) => seen.push(s)))
  return seen
}

/** A state an app reads as "done, nothing found" while its read is still to come. */
const looksEmpty = (s: Shown): boolean => s.enabled && !s.loading && s.data === null

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}))
  lifecycle.client = createClient<AnyDatabase>({ url: "http://localhost:9999", anonKey: "anon" })
})

afterEach(() => {
  for (const fn of lifecycle.destroy.splice(0)) fn()
  vi.unstubAllGlobals()
})

describe("createQuery's first value", () => {
  it("is loading when enabled with plain options", () => {
    const q = createQuery<AnyDatabase>("profiles", {})
    expect(record(q, writable({}))[0]).toEqual({ enabled: true, loading: true, data: null })
  })

  it("is loading when enabled with an options store", () => {
    const options = writable<QueryOptions>({})
    const q = createQuery<AnyDatabase>("profiles", options)
    expect(record(q, options)[0]).toEqual({ enabled: true, loading: true, data: null })
  })

  it("is not loading when disabled", () => {
    const options = writable<QueryOptions>({ enabled: false })
    const q = createQuery<AnyDatabase>("profiles", options)
    expect(record(q, options)).toEqual([{ enabled: false, loading: false, data: null }])
  })

  it("is loading from the moment the options store turns it on", () => {
    const options = writable<QueryOptions>({ enabled: false })
    const q = createQuery<AnyDatabase>("profiles", options)
    const seen = record(q, options)
    options.set({ enabled: true })
    expect(seen.filter(looksEmpty)).toEqual([])
    expect(seen.at(-1)).toEqual({ enabled: true, loading: true, data: null })
  })
})
