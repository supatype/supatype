/**
 * Svelte's stores end loading and hold the error when a request throws instead of answering.
 * `onDestroy` is collected rather than registered with a component: what is under test is the
 * stores' wiring over a real client.
 */

import { vi } from "vitest"
import { get } from "svelte/store"
import type { AnyDatabase, SupatypeClient } from "@supatype/client"
import { describeThrownErrorBinding } from "../../client/tests/helpers/thrown-error-binding.js"

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
import { createMutation } from "../src/createMutation.js"
import { createFunction } from "../src/createFunction.js"
import { createAuth } from "../src/createAuth.js"

describeThrownErrorBinding(
  "svelte",
  (client) => {
    lifecycle.client = client
    return {
      query: (table) => {
        const q = createQuery<AnyDatabase>(table)
        return { error: () => get(q.error), loading: () => get(q.loading) }
      },
      mutation: (table) => {
        const m = createMutation<AnyDatabase>(table, "insert")
        return { error: () => get(m.error), loading: () => get(m.loading), mutate: (row) => m.mutate(row) }
      },
      invoker: (name) => {
        const f = createFunction(name)
        return { error: () => get(f.error), loading: () => get(f.loading), invoke: (body) => f.invoke(body) }
      },
      auth: () => {
        const a = createAuth<AnyDatabase>()
        return { error: () => get(a.error), loading: () => get(a.loading) }
      },
    }
  },
  () => {
    for (const fn of lifecycle.destroy.splice(0)) fn()
  },
)
