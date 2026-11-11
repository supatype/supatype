/**
 * 0.9.2 release test (N-FF9): the first render comes before `onMount` starts the read, and
 * `loading` started false, so an enabled query first showed `loading: false, data: null`. An app
 * reads that pair as "done, nothing found". `onMount` is held here so the state is read at that
 * first render.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient, type AnyDatabase, type SupatypeClient } from "@supatype/client"

const lifecycle = vi.hoisted(() => ({
  mounted: [] as Array<() => void>,
  client: null as SupatypeClient<AnyDatabase> | null,
}))

vi.mock("solid-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("solid-js")>()),
  onMount: (fn: () => void) => lifecycle.mounted.push(fn),
  onCleanup: () => undefined,
}))

vi.mock("../src/context.js", () => ({
  useSupatype: () => lifecycle.client,
}))

import { createQuery } from "../src/createQuery.js"

lifecycle.client = createClient<AnyDatabase>({ url: "http://localhost:9999", anonKey: "anon" })

afterEach(() => {
  lifecycle.mounted.splice(0)
})

describe("createQuery before it is mounted", () => {
  it("is loading when enabled", () => {
    const q = createQuery<AnyDatabase>("profiles")
    expect({ loading: q.loading(), data: q.data() }).toEqual({ loading: true, data: null })
  })

  it("is not loading when disabled", () => {
    const q = createQuery<AnyDatabase>("profiles", () => ({ enabled: false }))
    expect(q.loading()).toBe(false)
  })
})
