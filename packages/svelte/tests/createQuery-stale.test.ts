/**
 * `createQuery` shows only the newest read when an older one finishes last. `onDestroy` is
 * collected rather than registered with a component.
 */

import { vi } from "vitest"
import { get } from "svelte/store"
import type { AnyDatabase, SupatypeClient } from "@supatype/client"
import { describeStaleReadBinding } from "../../client/tests/helpers/stale-read-binding.js"

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

describeStaleReadBinding(
  "createQuery",
  (client) => {
    lifecycle.client = client
    const q = createQuery<AnyDatabase>("posts")
    return { data: () => get(q.data), error: () => get(q.error), loading: () => get(q.loading), refetch: q.refetch }
  },
  () => {
    for (const fn of lifecycle.destroy.splice(0)) fn()
  },
)
