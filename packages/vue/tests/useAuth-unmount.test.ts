/**
 * `useAuth` leaves no auth listener behind when its component unmounts before the client has
 * started. Lifecycle hooks run directly: what is under test is the composable's wiring.
 */

import { vi } from "vitest"
import type { AnyDatabase, SupatypeClient } from "@supatype/client"
import { describeAuthUnmountBinding } from "../../client/tests/helpers/auth-unmount-binding.js"

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

import { useAuth } from "../src/useAuth.js"

describeAuthUnmountBinding(
  "useAuth",
  (client) => {
    lifecycle.client = client
    useAuth<AnyDatabase>()
  },
  () => {
    for (const fn of lifecycle.unmount.splice(0)) fn()
  },
)
