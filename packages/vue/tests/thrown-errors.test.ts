/**
 * Vue's composables end loading and hold the error when a request throws instead of answering.
 * Lifecycle hooks run directly: what is under test is the composables' wiring over a real client,
 * not Vue's mounting.
 */

import { vi } from "vitest"
import type { AnyDatabase, SupatypeClient } from "@supatype/client"
import { describeThrownErrorBinding } from "../../client/tests/helpers/thrown-error-binding.js"

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
import { useMutation } from "../src/useMutation.js"
import { useFunction } from "../src/useFunction.js"
import { useAuth } from "../src/useAuth.js"

describeThrownErrorBinding(
  "vue",
  (client) => {
    lifecycle.client = client
    return {
      query: (table) => {
        const q = useQuery<AnyDatabase>(table)
        return { error: () => q.error.value, loading: () => q.loading.value }
      },
      mutation: (table) => {
        const m = useMutation<AnyDatabase>(table, "insert")
        return { error: () => m.error.value, loading: () => m.loading.value, mutate: (row) => m.mutate(row) }
      },
      invoker: (name) => {
        const f = useFunction(name)
        return { error: () => f.error.value, loading: () => f.loading.value, invoke: (body) => f.invoke(body) }
      },
      auth: () => {
        const a = useAuth<AnyDatabase>()
        return { error: () => a.error.value, loading: () => a.loading.value }
      },
    }
  },
  () => {
    for (const fn of lifecycle.unmount.splice(0)) fn()
  },
)
