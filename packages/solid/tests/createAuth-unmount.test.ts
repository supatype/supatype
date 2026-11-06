/**
 * `createAuth` leaves no auth listener behind when its owner is cleaned up before the client has
 * started. `onMount` runs directly and `onCleanup` is collected: under Node, solid-js resolves to
 * its server build.
 */

import { vi } from "vitest"
import type { AnyDatabase, SupatypeClient } from "@supatype/client"
import { describeAuthUnmountBinding } from "../../client/tests/helpers/auth-unmount-binding.js"

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

import { createAuth } from "../src/createAuth.js"

describeAuthUnmountBinding(
  "createAuth",
  (client) => {
    lifecycle.client = client
    createAuth<AnyDatabase>()
  },
  () => {
    for (const fn of lifecycle.cleanup.splice(0)) fn()
  },
)
