import { expect, test, type Page } from "@playwright/test"

/**
 * Signing in to the kitchen-sink app with GitHub, the whole way round.
 *
 * The app's "Sign in with GitHub" button had only ever been rendered, never pressed against a
 * server. Pressing it sent the user to the provider and back to a signed-out page with the tokens
 * still in the address bar: nothing read the redirect. These press it against the real auth server,
 * whose GitHub provider is pointed at a stub (tests/e2e/expo-auth/oauth-stub.mjs) that approves at
 * once, and assert what the person sees on the way back and what the server recorded.
 *
 * Run by tests/integration/scripts/kitchen-sink-e2e.sh, which starts the stack, seeds it, starts
 * the stub and points the provider at it.
 */

const STUB = process.env.OAUTH_STUB_URL ?? "http://127.0.0.1:18997"
const STUB_EMAIL = process.env.OAUTH_STUB_EMAIL ?? ""
const STUB_HOST = process.env.OAUTH_STUB_HOST ?? "host.docker.internal"
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY ?? ""

// The auth server reaches the stub at host.docker.internal, and the browser follows the same URL to
// it, so the browser resolves that name to this machine.
test.use({ launchOptions: { args: [`--host-resolver-rules=MAP ${STUB_HOST} 127.0.0.1`] } })

interface AdminIdentity {
  provider: string
}

interface AdminUser {
  id: string
  email?: string
  app_metadata?: { providers?: string[] } | null
  identities?: AdminIdentity[] | null
}

/** A GET on the auth admin API as the service role. */
async function adminGet<T>(baseURL: string, path: string): Promise<T> {
  const res = await fetch(`${baseURL}/auth/v1/admin${path}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  })
  expect(res.status, `GET /auth/v1/admin${path}`).toBe(200)
  return (await res.json()) as T
}

/**
 * The user as Studio's Users view sees it: listed under `email`, then read by id.
 *
 * The list does not load identities (the auth server's FindUsersInAudience, as upstream), so the
 * provider is asserted where each answer carries it: `app_metadata.providers` on the list, and
 * `identities` on the user read by id.
 */
async function expectGitHubUser(baseURL: string, email: string): Promise<void> {
  const { users } = await adminGet<{ users?: AdminUser[] }>(baseURL, "/users?per_page=1000")
  const listed = users?.find((u) => u.email === email)
  if (listed === undefined) throw new Error(`the admin API does not list ${email}`)
  expect(listed.app_metadata?.providers ?? [], "the listed user's providers").toContain("github")
  const user = await adminGet<AdminUser>(baseURL, `/users/${listed.id}`)
  expect((user.identities ?? []).map((i) => i.provider), "the user's identities").toContain("github")
}

/** Presses the button and waits for the document the round trip lands on. */
async function signInWithGitHub(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "networkidle" })
  // Every hop (authorize, the provider, the callback) is an HTTP redirect, so the first document the
  // main frame commits after the click is the one the server sent the browser back to.
  const landed = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame() })
  await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).click()
  await landed
  await page.waitForLoadState("networkidle")
}

test.describe("the kitchen-sink app's GitHub sign-in", () => {
  test("comes back signed in, with nothing left in the address bar", async ({ page, baseURL }) => {
    if (STUB_EMAIL === "" || SERVICE_ROLE_KEY === "") {
      throw new Error("OAUTH_STUB_EMAIL and SERVICE_ROLE_KEY must be set (kitchen-sink-e2e.sh sets both)")
    }
    await signInWithGitHub(page)

    // Soft, so a run that also fails to sign in reports both. The server sends the session back in
    // the fragment; a page that keeps it there hands it to anyone the link is shared with.
    await expect.soft.poll(() => new URL(page.url()).hash, { message: "no tokens in the fragment" }).not.toMatch(
      /access_token|refresh_token/,
    )
    await expect.soft.poll(() => new URL(page.url()).searchParams.has("code"), { message: "no code in the query" }).toBe(
      false,
    )

    // Signed in as the provider's user: the nav exists only with a session, the bar names the
    // account, and the programme is readable, which its access rule refuses to `anon`.
    await expect(page.getByRole("button", { name: "Programme", exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(STUB_EMAIL, { exact: true })).toBeVisible()
    await expect(page.getByText("Types all the way down")).toBeVisible()

    const calls = (await (await fetch(`${STUB}/calls`)).json()) as string[]
    expect(calls).toEqual(
      expect.arrayContaining(["GET /login/oauth/authorize", "POST /login/oauth/access_token", "GET /api/v3/user"]),
    )
    await expectGitHubUser(baseURL ?? "", STUB_EMAIL)
  })

  test("says a disabled provider is disabled instead of opening the server's JSON", async ({ page }) => {
    // GitHub is on in this stack, so the server's answer for a provider that is off is stood in for:
    // /settings reports it off, and /authorize answers as the server does for one, with a bare 400.
    await page.route("**/auth/v1/settings", async (route) => {
      const real = await route.fetch()
      const settings = (await real.json()) as { external?: Record<string, boolean> }
      await route.fulfill({ response: real, json: { ...settings, external: { ...settings.external, github: false } } })
    })
    await page.route("**/auth/v1/authorize?**", (route) =>
      route.fulfill({
        status: 400,
        json: { code: 400, error_code: "validation_failed", msg: "Unsupported provider: provider is not enabled" },
      }),
    )
    await page.goto("/", { waitUntil: "networkidle" })
    const before = page.url()

    await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).click()

    await expect(page.locator(".ks-note--error")).toContainText(/not enabled/i)
    expect(page.url(), "the page stays on the app").toBe(before)
    await expect(page.getByText("validation_failed")).toHaveCount(0)
  })
})
