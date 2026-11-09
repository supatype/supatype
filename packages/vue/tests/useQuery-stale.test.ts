/**
 * `useQuery` shows only the newest read when an older one finishes last. Lifecycle hooks run
 * directly: what is under test is the composable's wiring over a real client.
 */

import { vi } from "vitest"
import type { AnyDatabase, SupatypeClient } from "@supatype/client"
import { describeStaleReadBinding } from "../../client/tests/helpers/stale-read-binding.js"

const lifecycle = vi.hoisted(() => ({
  unmount: [] as Array<() => void>,
  client: null as SupatypeClient<AnyDatabase> | null,
}))

vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onMounted: (fn: () => void) => fn(),
  onUnmounted: (fn: () => void) => lifecycle.unmount.push(fn),
}))

vi.mock("../src/context.js", () => ({
  useSupatype: () => lifecycle.client,
}))

import { useQuery } from "../src/useQuery.js"

describeStaleReadBinding(
  "useQuery",
  (client) => {
    lifecycle.client = client
    const q = useQuery<AnyDatabase>("posts")
    return { data: () => q.data.value, error: () => q.error.value, loading: () => q.loading.value, refetch: q.refetch }
  },
  () => {
    for (const fn of lifecycle.unmount.splice(0)) fn()
  },
)
