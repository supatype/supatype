/**
 * `createAuth` leaves no auth listener behind when its component is destroyed before the client
 * has started. `onDestroy` is collected rather than registered with a component.
 */

import { vi } from "vitest"
import type { AnyDatabase, SupatypeClient } from "@supatype/client"
import { describeAuthUnmountBinding } from "../../client/tests/helpers/auth-unmount-binding.js"

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

import { createAuth } from "../src/createAuth.js"

describeAuthUnmountBinding(
  "createAuth",
  (client) => {
    lifecycle.client = client
    createAuth<AnyDatabase>()
  },
  () => {
    for (const fn of lifecycle.destroy.splice(0)) fn()
  },
)
