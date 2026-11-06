/**
 * `createQuery` shows only the newest read when an older one finishes last. `onMount` runs
 * directly and `onCleanup` is collected: under Node, solid-js resolves to its server build.
 */

import { vi } from "vitest"
import type { AnyDatabase, SupatypeClient } from "@supatype/client"
import { describeStaleReadBinding } from "../../client/tests/helpers/stale-read-binding.js"

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

describeStaleReadBinding(
  "createQuery",
  (client) => {
    lifecycle.client = client
    const q = createQuery<AnyDatabase>("posts")
    return { data: q.data, error: q.error, loading: q.loading, refetch: q.refetch }
  },
  () => {
    for (const fn of lifecycle.cleanup.splice(0)) fn()
  },
)
