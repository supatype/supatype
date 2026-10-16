/**
 * `createAuth` starts an OAuth sign-in and shows the server's refusal, as every binding must.
 *
 * `signInWithOAuth` used to drop the URL the client returned, so the browser never left the page,
 * and a refusal sent back in the redirect URL had nowhere to show. `onDestroy` is collected rather
 * than registered with a component: what is under test is the store's wiring.
 */

import { vi } from "vitest"
import { get } from "svelte/store"
import { describeOAuthBinding, type OAuthBindingHarness } from "../../client/tests/helpers/oauth-binding.js"

const lifecycle = vi.hoisted(() => ({ destroy: [] as Array<() => void>, harness: null as OAuthBindingHarness | null }))

vi.mock("svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("svelte")>()),
  onDestroy: (fn: () => void) => lifecycle.destroy.push(fn),
}))

vi.mock("../src/context.js", () => ({
  getSupatypeClient: () => ({ auth: lifecycle.harness?.auth }),
}))

import { createAuth } from "../src/createAuth.js"

describeOAuthBinding(
  "createAuth",
  (harness) => {
    lifecycle.harness = harness
    const auth = createAuth()
    return { error: () => (auth.error === undefined ? undefined : get(auth.error)), signInWithOAuth: auth.signInWithOAuth }
  },
  () => {
    for (const fn of lifecycle.destroy.splice(0)) fn()
  },
)
