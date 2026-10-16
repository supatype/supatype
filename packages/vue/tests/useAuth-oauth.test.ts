/**
 * `useAuth` starts an OAuth sign-in and shows the server's refusal, as every binding must.
 *
 * `signInWithOAuth` used to drop the URL the client returned, so the browser never left the page,
 * and a refusal sent back in the redirect URL had nowhere to show. Lifecycle hooks run directly:
 * what is under test is the composable's wiring, not Vue's mounting.
 */

import { vi } from "vitest"
import { describeOAuthBinding, type OAuthBindingHarness } from "../../client/tests/helpers/oauth-binding.js"

const lifecycle = vi.hoisted(() => ({ unmount: [] as Array<() => void>, harness: null as OAuthBindingHarness | null }))

vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onMounted: (fn: () => void) => fn(),
  onUnmounted: (fn: () => void) => lifecycle.unmount.push(fn),
}))

vi.mock("../src/context.js", () => ({
  useSupatype: () => ({ auth: lifecycle.harness?.auth }),
}))

import { useAuth } from "../src/useAuth.js"

describeOAuthBinding(
  "useAuth",
  (harness) => {
    lifecycle.harness = harness
    const auth = useAuth()
    return { error: () => auth.error?.value, signInWithOAuth: auth.signInWithOAuth }
  },
  () => {
    for (const fn of lifecycle.unmount.splice(0)) fn()
  },
)
