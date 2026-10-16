/**
 * `createAuth` stays signed out after a sign-up that waits for email confirmation, and returns
 * what the app needs to say so. `onMount` runs directly and `onCleanup` is collected: under Node,
 * solid-js resolves to its server build.
 */

import { vi } from "vitest"
import type { AuthClient } from "../../client/src/auth.js"
import { describeSignUpBinding } from "../../client/tests/helpers/signup-binding.js"

const lifecycle = vi.hoisted(() => ({ cleanup: [] as Array<() => void>, auth: null as AuthClient | null }))

vi.mock("solid-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("solid-js")>()),
  onMount: (fn: () => void) => fn(),
  onCleanup: (fn: () => void) => lifecycle.cleanup.push(fn),
}))

vi.mock("../src/context.js", () => ({
  useSupatype: () => ({ auth: lifecycle.auth }),
}))

import { createAuth } from "../src/createAuth.js"

describeSignUpBinding(
  "createAuth",
  (auth) => {
    lifecycle.auth = auth
    const state = createAuth()
    return { user: state.user, signUp: state.signUp }
  },
  () => {
    for (const fn of lifecycle.cleanup.splice(0)) fn()
  },
)
