/**
 * `createAuth` starts an OAuth sign-in and shows the server's refusal, as every binding must.
 *
 * `signInWithOAuth` used to drop the URL the client returned, so the browser never left the page,
 * and a refusal sent back in the redirect URL had nowhere to show. `onMount` runs directly and
 * `onCleanup` is collected: under Node, solid-js resolves to its server build.
 */

import { vi } from "vitest"
import { describeOAuthBinding, type OAuthBindingHarness } from "../../client/tests/helpers/oauth-binding.js"

const lifecycle = vi.hoisted(() => ({ cleanup: [] as Array<() => void>, harness: null as OAuthBindingHarness | null }))

vi.mock("solid-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("solid-js")>()),
  onMount: (fn: () => void) => fn(),
  onCleanup: (fn: () => void) => lifecycle.cleanup.push(fn),
}))

vi.mock("../src/context.js", () => ({
  useSupatype: () => ({ auth: lifecycle.harness?.auth }),
}))

import { createAuth } from "../src/createAuth.js"

describeOAuthBinding(
  "createAuth",
  (harness) => {
    lifecycle.harness = harness
    const auth = createAuth()
    return { error: () => auth.error?.(), signInWithOAuth: auth.signInWithOAuth }
  },
  () => {
    for (const fn of lifecycle.cleanup.splice(0)) fn()
  },
)
