/**
 * 0.9.2 release test (N-FF9): the first render comes before `onMounted` starts the read, and
 * `loading` started false, so an enabled query first showed `loading: false, data: null`. An app
 * reads that pair as "done, nothing found". `onMounted` is held here so the state is read at
 * that first render.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient, type AnyDatabase, type SupatypeClient } from "@supatype/client"

const lifecycle = vi.hoisted(() => ({
  mounted: [] as Array<() => void>,
  client: null as SupatypeClient<AnyDatabase> | null,
}))

vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onMounted: (fn: () => void) => lifecycle.mounted.push(fn),
  onUnmounted: () => undefined,
}))

vi.mock("../src/context.js", () => ({
  useSupatype: () => lifecycle.client,
}))

import { useQuery } from "../src/useQuery.js"

lifecycle.client = createClient<AnyDatabase>({ url: "http://localhost:9999", anonKey: "anon" })

afterEach(() => {
  lifecycle.mounted.splice(0)
})

describe("useQuery before it is mounted", () => {
  it("is loading when enabled", () => {
    const q = useQuery<AnyDatabase>("profiles")
    expect({ loading: q.loading.value, data: q.data.value }).toEqual({ loading: true, data: null })
  })

  it("is not loading when disabled", () => {
    const q = useQuery<AnyDatabase>("profiles", { enabled: false })
    expect(q.loading.value).toBe(false)
  })
})
