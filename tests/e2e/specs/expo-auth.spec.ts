import { expect, test, type Page } from "@playwright/test"

/**
 * The expo-auth example, run as its Expo web build and driven as a person drives it.
 *
 * The README lists what the app does: email and password, magic link, password reset, and Google
 * and GitHub OAuth through PKCE (`openOAuth`). The only automation was a node smoke script that
 * called the client directly, so nothing proved the screens are wired to any of it: a form that
 * never submits, a link that lands on a page which ignores it, or an OAuth popup that never hands
 * its code back would all have passed.
 *
 * Mail is read from the SMTP catcher the stack is pointed at. OAuth runs against a stub provider
 * shaped like GitHub Enterprise (tests/e2e/expo-auth/oauth-stub.mjs), which the auth server is
 * configured to use, so the whole PKCE round trip runs against the real auth server.
 *
 * Run by tests/integration/scripts/expo-auth-e2e.sh, which starts the stack, the catcher, the stub
 * and the web build.
 */

const APP = process.env.EXPO_E2E_APP_URL ?? "http://127.0.0.1:8089"
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:18026"
const STUB = process.env.OAUTH_STUB_URL ?? "http://127.0.0.1:18998"
const STUB_EMAIL = process.env.OAUTH_STUB_EMAIL ?? ""
const STUB_HOST = process.env.OAUTH_STUB_HOST ?? "host.docker.internal"
const PASSWORD = "expo-e2e-password-1"
const RUN = `${Date.now()}`

// The auth server reaches the stub at host.docker.internal, and the browser must follow the same
// URL to it, so the browser resolves that name to this machine.
test.use({ launchOptions: { args: [`--host-resolver-rules=MAP ${STUB_HOST} 127.0.0.1`] } })

const freshEmail = (label: string): string => `expo-${label}-${RUN}@example.com`

interface MailpitSummary {
  ID: string
}

/** The first link to the auth server's /verify endpoint in the newest message to `email`. */
async function emailedLink(email: string): Promise<string> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    const found = (await res.json()) as { messages?: MailpitSummary[] }
    const first = found.messages?.[0]
    if (first !== undefined) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${first.ID}`)).json()) as { HTML?: string; Text?: string }
      const body = `${full.HTML ?? ""}\n${full.Text ?? ""}`.replaceAll("&amp;", "&")
      const link = /https?:\/\/[^\s"'<>]+\/verify\?[^\s"'<>]+/.exec(body)?.[0]
      if (link !== undefined) return link
      throw new Error(`the message to ${email} has no /verify link`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`no email reached ${email} within 30s`)
}

async function openAuthTab(page: Page, label: string): Promise<void> {
  await page.getByText(label, { exact: true }).first().click()
}

/** Signed in: the profile tab names the account. */
async function expectSignedInAs(page: Page, email: string): Promise<void> {
  // The tab, not the heading of the same name on the profile screen above it.
  await page.getByText("Profile", { exact: true }).last().click()
  await expect(page.getByText(email, { exact: true })).toBeVisible({ timeout: 30_000 })
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click()
  await expect(page.getByTestId("st-login-email")).toBeVisible()
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByTestId("st-login-email").fill(email)
  await page.getByTestId("st-login-password").fill(password)
  await page.getByTestId("st-login-submit").click()
}

async function signUp(page: Page, email: string): Promise<void> {
  await page.goto(APP)
  await openAuthTab(page, "Sign up")
  await page.getByTestId("st-signup-email").fill(email)
  await page.getByTestId("st-signup-password").fill(PASSWORD)
  await page.getByTestId("st-signup-submit").click()
  await expectSignedInAs(page, email)
}

/** Presses a provider's button and returns the authorize URL its popup opened, as openOAuth built it. */
async function clickToAuthorize(page: Page, provider: string): Promise<URL> {
  const request = page.context().waitForEvent("request", {
    predicate: (r) => new URL(r.url()).pathname === "/auth/v1/authorize",
  })
  await page.getByTestId(`st-oauth-${provider}`).click()
  const url = new URL((await request).url())
  expect(url.searchParams.get("provider")).toBe(provider)
  return url
}

test.describe("expo-auth on web", () => {
  test("email and password: sign up, sign out, sign in again, and a wrong password is refused", async ({ page }) => {
    const email = freshEmail("password")
    await signUp(page, email)
    await signOut(page)

    await signIn(page, email, "not-the-password")
    await expect(page.getByRole("alert")).toBeVisible()
    await expect(page.getByTestId("st-login-email")).toBeVisible()

    await signIn(page, email, PASSWORD)
    await expectSignedInAs(page, email)

    // Persistence: the session survives a reload, as it survives a relaunch on a phone.
    await page.reload()
    await expectSignedInAs(page, email)
  })

  test("magic link: the emailed link opens the app on its callback and signs in", async ({ page }) => {
    const email = freshEmail("magic")
    await page.goto(APP)
    await openAuthTab(page, "Magic link")
    await page.getByTestId("st-magic-link-email").fill(email)
    await page.getByTestId("st-magic-link-submit").click()
    await expect(page.getByTestId("st-magic-link-sent")).toBeVisible()

    const link = await emailedLink(email)
    // The app asked for its own callback as the redirect; a link that ignores it lands on SITE_URL.
    expect(new URL(link).searchParams.get("redirect_to")).toBe(`${new URL(APP).origin}/auth/callback`)
    await page.goto(link)
    await expect(page).toHaveURL(/\/auth\/callback/)
    await expectSignedInAs(page, email)
  })

  test("password reset: the emailed link asks for a new password, and only the new one works", async ({ page }) => {
    const email = freshEmail("reset")
    await signUp(page, email)
    await signOut(page)

    await openAuthTab(page, "Reset")
    await page.getByTestId("st-reset-email").fill(email)
    await page.getByTestId("st-reset-submit").click()
    await expect(page.getByTestId("st-reset-sent")).toBeVisible()

    await page.goto(await emailedLink(email))
    const newPassword = "expo-e2e-password-2"
    await page.getByTestId("st-reset-password").fill(newPassword)
    await page.getByTestId("st-reset-submit").click()
    await expectSignedInAs(page, email)
    await signOut(page)

    await signIn(page, email, PASSWORD)
    await expect(page.getByRole("alert")).toBeVisible()
    await signIn(page, email, newPassword)
    await expectSignedInAs(page, email)
  })

  test("GitHub OAuth: the PKCE round trip through a stub provider signs the user in", async ({ page }) => {
    if (STUB_EMAIL === "") throw new Error("OAUTH_STUB_EMAIL must be set")
    await page.goto(APP)
    const authorize = await clickToAuthorize(page, "github")
    expect(authorize.searchParams.get("code_challenge_method")).toBe("s256")
    expect(authorize.searchParams.get("code_challenge") ?? "").toMatch(/^[A-Za-z0-9_-]{43}$/)

    await expectSignedInAs(page, STUB_EMAIL)
    const calls = (await (await fetch(`${STUB}/calls`)).json()) as string[]
    expect(calls).toEqual(
      expect.arrayContaining(["GET /login/oauth/authorize", "POST /login/oauth/access_token", "GET /api/v3/user"]),
    )
  })

  test("Google OAuth: the button starts a PKCE authorize request at the auth server", async ({ page }) => {
    // The server half of Google cannot run against a stub: the auth server pins Google's issuer
    // to accounts.google.com, so only the request the app makes is asserted here.
    await page.goto(APP)
    const authorize = await clickToAuthorize(page, "google")
    expect(authorize.searchParams.get("redirect_to")).toBe(`${new URL(APP).origin}/auth/callback`)
    expect(authorize.searchParams.get("code_challenge_method")).toBe("s256")
  })
})
