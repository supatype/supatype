/**
 * `createAuth` stays signed out after a sign-up that waits for email confirmation, and returns
 * what the app needs to say so. `onDestroy` is collected rather than registered with a component:
 * what is under test is the store's wiring over a real AuthClient.
 */

import { vi } from "vitest"
import { get } from "svelte/store"
import type { AuthClient } from "../../client/src/auth.js"
import { describeSignUpBinding } from "../../client/tests/helpers/signup-binding.js"

const lifecycle = vi.hoisted(() => ({ destroy: [] as Array<() => void>, auth: null as AuthClient | null }))

vi.mock("svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("svelte")>()),
  onDestroy: (fn: () => void) => lifecycle.destroy.push(fn),
}))

vi.mock("../src/context.js", () => ({
  getSupatypeClient: () => ({ auth: lifecycle.auth }),
}))

import { createAuth } from "../src/createAuth.js"

describeSignUpBinding(
  "createAuth",
  (auth) => {
    lifecycle.auth = auth
    const state = createAuth()
    return { user: () => get(state.user), signUp: state.signUp }
  },
  () => {
    for (const fn of lifecycle.destroy.splice(0)) fn()
  },
)
