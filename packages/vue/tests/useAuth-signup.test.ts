/**
 * `useAuth` stays signed out after a sign-up that waits for email confirmation, and returns what
 * the app needs to say so. Lifecycle hooks run directly: what is under test is the composable's
 * wiring over a real AuthClient, not Vue's mounting.
 */

import { vi } from "vitest"
import type { AuthClient } from "../../client/src/auth.js"
import { describeSignUpBinding } from "../../client/tests/helpers/signup-binding.js"

const lifecycle = vi.hoisted(() => ({ unmount: [] as Array<() => void>, auth: null as AuthClient | null }))

vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onMounted: (fn: () => void) => fn(),
  onUnmounted: (fn: () => void) => lifecycle.unmount.push(fn),
}))

vi.mock("../src/context.js", () => ({
  useSupatype: () => ({ auth: lifecycle.auth }),
}))

import { useAuth } from "../src/useAuth.js"

describeSignUpBinding(
  "useAuth",
  (auth) => {
    lifecycle.auth = auth
    const state = useAuth()
    return { user: () => state.user.value, signUp: state.signUp }
  },
  () => {
    for (const fn of lifecycle.unmount.splice(0)) fn()
  },
)
