/**
 * Solid's primitives end loading and hold the error when a request throws instead of answering.
 * `onMount` runs directly and `onCleanup` is collected: under Node, solid-js resolves to its server
 * build.
 */

import { vi } from "vitest"
import type { AnyDatabase, SupatypeClient } from "@supatype/client"
import { describeThrownErrorBinding } from "../../client/tests/helpers/thrown-error-binding.js"

const lifecycle = vi.hoisted(() => ({
  cleanup: [] as Array<() => void>,
  client: null as SupatypeClient<AnyDatabase> | null,
}))

vi.mock("solid-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("solid-js")>()),
  onMount: (fn: () => void) => fn(),
  onCleanup: (fn: () => void) => lifecycle.cleanup.push(fn),
}))

vi.mock("../src/context.js", () => ({
  useSupatype: () => lifecycle.client,
}))

import { createQuery } from "../src/createQuery.js"
import { createMutation } from "../src/createMutation.js"
import { createFunction } from "../src/createFunction.js"
import { createAuth } from "../src/createAuth.js"

describeThrownErrorBinding(
  "solid",
  (client) => {
    lifecycle.client = client
    return {
      query: (table) => {
        const q = createQuery<AnyDatabase>(table)
        return { error: q.error, loading: q.loading }
      },
      mutation: (table) => {
        const m = createMutation<AnyDatabase>(table, "insert")
        return { error: m.error, loading: m.loading, mutate: (row) => m.mutate(row) }
      },
      invoker: (name) => {
        const f = createFunction(name)
        return { error: f.error, loading: f.loading, invoke: (body) => f.invoke(body) }
      },
      auth: () => {
        const a = createAuth<AnyDatabase>()
        return { error: a.error, loading: a.loading }
      },
    }
  },
  () => {
    for (const fn of lifecycle.cleanup.splice(0)) fn()
  },
)
