/**
 * `createQuery` reads again when its options change, passed as a store. `onDestroy` is collected
 * rather than registered with a component.
 */

import { vi } from "vitest"
import { writable } from "svelte/store"
import type { AnyDatabase, SupatypeClient } from "@supatype/client"
import { describeReactiveOptionsBinding, type ReadOptions } from "../../client/tests/helpers/reactive-options-binding.js"

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

import { createQuery } from "../src/createQuery.js"

describeReactiveOptionsBinding(
  "createQuery with a store",
  (client, initial) => {
    lifecycle.client = client
    const options = writable<ReadOptions>(initial)
    createQuery<AnyDatabase>("posts", options)
    return { change: (next) => options.set(next) }
  },
  () => {
    for (const fn of lifecycle.destroy.splice(0)) fn()
  },
)
