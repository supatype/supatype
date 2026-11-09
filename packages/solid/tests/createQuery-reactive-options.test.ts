/**
 * `createQuery` reads again when its options change, passed as an accessor.
 *
 * Under Node, `solid-js` resolves to its server build, where effects never run, so this suite
 * swaps in the browser build: what is under test is that an effect tracks the options.
 */

import { vi } from "vitest"
import type { AnyDatabase, SupatypeClient } from "@supatype/client"
import { describeReactiveOptionsBinding, type ReadOptions } from "../../client/tests/helpers/reactive-options-binding.js"

const lifecycle = vi.hoisted(() => ({
  dispose: [] as Array<() => void>,
  client: null as SupatypeClient<AnyDatabase> | null,
}))

vi.mock("solid-js", () => import("solid-js/dist/solid.js"))

vi.mock("../src/context.js", () => ({
  useSupatype: () => lifecycle.client,
}))

import { createRoot, createSignal } from "solid-js"
import { createQuery } from "../src/createQuery.js"

describeReactiveOptionsBinding(
  "createQuery with an accessor",
  (client, initial) => {
    lifecycle.client = client
    const [options, setOptions] = createSignal<ReadOptions>(initial)
    createRoot((dispose) => {
      lifecycle.dispose.push(dispose)
      createQuery<AnyDatabase>("posts", options)
    })
    return { change: (next) => setOptions(next) }
  },
  () => {
    for (const fn of lifecycle.dispose.splice(0)) fn()
  },
)
