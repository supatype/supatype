/**
 * `useQuery` reads again when its options change: options passed as a ref, and as a getter.
 * Lifecycle hooks run directly: what is under test is the composable's wiring over a real client.
 */

import { vi } from "vitest"
import { ref } from "vue"
import type { AnyDatabase, SupatypeClient } from "@supatype/client"
import { describeReactiveOptionsBinding, type ReadOptions } from "../../client/tests/helpers/reactive-options-binding.js"

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

const unmount = (): void => {
  for (const fn of lifecycle.unmount.splice(0)) fn()
}

describeReactiveOptionsBinding(
  "useQuery with a ref",
  (client, initial) => {
    lifecycle.client = client
    const options = ref<ReadOptions>(initial)
    useQuery<AnyDatabase>("posts", options)
    return { change: (next) => { options.value = next } }
  },
  unmount,
)

describeReactiveOptionsBinding(
  "useQuery with a getter",
  (client, initial) => {
    lifecycle.client = client
    const order = ref(initial.order)
    const offset = ref(initial.offset)
    const filter = ref(initial.filter)
    const enabled = ref(initial.enabled)
    useQuery<AnyDatabase>("posts", () => ({
      order: order.value,
      limit: 2,
      offset: offset.value,
      filter: filter.value,
      enabled: enabled.value,
    }))
    return {
      change: (next) => {
        order.value = next.order
        offset.value = next.offset
        filter.value = next.filter
        enabled.value = next.enabled
      },
    }
  },
  unmount,
)
