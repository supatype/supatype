import { expect, test, type Page } from "@playwright/test"

/**
 * The kitchen-sink attendee app, which had no browser coverage at all.
 *
 * `verify.ts` asserts the things a browser cannot distinguish: a socket that delivers versus one
 * that merely opens, an access rule that filters versus a query that matched nothing. It says
 * nothing about whether any of it reaches a screen. The app was rewritten from a five-tab demo
 * harness into a conference app, and the whole rewrite was visible only in a screenshot, which is
 * not a test.
 *
 * So these drive the real build through the real gateway. They assert what the screens are *for*
 * rather than how they are laid out: that the programme groups published talks by day and excludes
 * the unpublished one, that a speaker with no English bio says so rather than borrowing another
 * language, that the lobby refuses a message the schema refuses. A test that asserted class names
 * would break on the next redesign without saying anything about whether the app works.
 *
 * Requires `pnpm seed` to have run: the fixtures below are the seed's, and an empty database fails
 * these with an empty-state message rather than a confusing assertion.
 */

const PASSWORD = "correct-horse-battery"

/** A fresh attendee per run, because signing up is the only way in and accounts persist. */
function freshEmail(): string {
  return `ks-e2e-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.com`
}

async function signUp(page: Page): Promise<string> {
  const email = freshEmail()
  await page.goto("/", { waitUntil: "networkidle" })

  // The screen opens in sign-up mode; the toggle only matters if that default changes.
  const toggle = page.getByRole("button", { name: /need an account\? sign up/i })
  if (await toggle.isVisible().catch(() => false)) await toggle.click()

  await page.locator('input[type="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(PASSWORD)
  await page.getByRole("button", { name: /sign up|create account/i }).first().click()

  // The nav only exists once there is a session, so it is the signal rather than a timeout.
  await expect(page.getByRole("button", { name: "Programme", exact: true })).toBeVisible({
    timeout: 30_000,
  })
  return email
}

async function open(page: Page, screen: string): Promise<void> {
  await page.getByRole("button", { name: screen, exact: true }).first().click()
  await expect(page.getByRole("heading", { name: screen === "My ticket" ? /my ticket/i : new RegExp(screen, "i") })).toBeVisible()
}

test.describe("the kitchen-sink attendee app", () => {
  test("shows the conference's own name, not the sample's", async ({ page }) => {
    await signUp(page)
    // From `_global_site_settings`, a singleton an editor owns. The app used to hardcode
    // "Kitchen Sink", which is the name of the example rather than the event it runs.
    await expect(page.getByText("Kitchen Sink Conference")).toBeVisible()
  })

  test("groups the programme by day and renders what a talk is", async ({ page }) => {
    await signUp(page)

    // Two seeded days, so grouping is observable rather than implied by one heading.
    const days = page.locator(".ks-day")
    await expect(days).toHaveCount(2)

    // A talk carries its speaker and its room, both fetched separately and joined in the client.
    const slot = page.locator(".ks-slot").first()
    await expect(slot).toContainText(/\d{2}:\d{2}/)
    await expect(page.getByText("Main Hall · 400 seats").first()).toBeVisible()
    await expect(page.getByText("Ada Buckley").first()).toBeVisible()
  })

  test("omits the unpublished talk, with no filter in the query", async ({ page }) => {
    await signUp(page)
    // `Talk` is read-gated on `Lte<"published_at", Now>`. The seed leaves exactly one talk
    // unpublished, and the app selects every talk without a `where` clause, so its absence here is
    // the access rule doing the work rather than the client remembering to ask.
    await expect(page.getByText("Types all the way down")).toBeVisible()
    await expect(page.getByText("Unfinished thoughts on indexes")).toHaveCount(0)
  })

  test("says a missing translation is missing rather than falling back", async ({ page }) => {
    await signUp(page)
    await open(page, "Speakers")

    await expect(page.getByText("Rune Oyelaran")).toBeVisible()
    // Every seeded speaker has an English bio, so none of these should read as absent. The
    // assertion is the inverse of the bug it guards: a speaker upsert that only updated `name`
    // left old rows with a null bio, and the screen said "No English bio yet" beside a seed that
    // plainly had one.
    await expect(page.getByText("No English bio yet.")).toHaveCount(0)
  })

  test("refuses a message the schema refuses, and says which rule", async ({ page }) => {
    await signUp(page)
    await open(page, "Lobby")

    const box = page.getByLabel("Message")

    // A model constraint: `Gte<Length<"body">, Literal<2>>`. Refused by Postgres, so the message
    // is a constraint violation rather than anything the field can explain.
    await box.fill("x")
    await page.getByRole("button", { name: "Send" }).click()
    await expect(page.locator(".ks-note--error")).toBeVisible()

    // A validator: the only one of the three that can name the field and say what to change.
    await box.fill("HELLO EVERYONE AT THIS CONFERENCE")
    await page.getByRole("button", { name: "Send" }).click()
    await expect(page.locator(".ks-note--error")).toContainText(/shouting|lower case/i)
  })

  test("delivers an accepted message back through the socket", async ({ page }) => {
    await signUp(page)
    await open(page, "Lobby")

    // Nothing is rendered optimistically: the list is what arrived on the subscription. A message
    // appearing here therefore proves delivery, which a SUBSCRIBED badge does not.
    await expect(page.getByText("live")).toBeVisible()

    const said = `programme looks good ${Date.now()}`
    await page.getByLabel("Message").fill(said)
    await page.getByRole("button", { name: "Send" }).click()
    await expect(page.getByText(said)).toBeVisible({ timeout: 30_000 })
  })

  test("returns no ticket to an attendee who has none, rather than someone else's", async ({ page }) => {
    await signUp(page)
    await open(page, "My ticket")

    // `OwnerFrom<"authUser">` on an unfiltered select: a brand-new account owns no ticket, so the
    // list is empty. Seeing anybody else's here would be the access rule failing.
    await expect(page.getByText("No ticket on this account")).toBeVisible()
    await expect(page.getByRole("button", { name: /claim a ticket/i })).toBeVisible()
  })

  test("orders sponsors by tier", async ({ page }) => {
    await signUp(page)
    await open(page, "Sponsors")

    await expect(page.getByText("Northwind Databases")).toBeVisible()
    // Platinum first, whatever order the rows came back in.
    const badges = page.locator(".ks-badge")
    await expect(badges.first()).toContainText("platinum")
  })

  test("keeps the explanation out of the chrome", async ({ page }) => {
    await signUp(page)

    // The old shell printed `Proves: useQuery, relations, ordering` under the navigation, which
    // made a conference app read as a fixture. The explanation is still here, behind a control,
    // because reading the example is the point.
    await expect(page.getByText(/^Proves:/)).toHaveCount(0)

    const toggle = page.getByRole("button", { name: /what this demonstrates/i })
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(page.getByText(/published_at/).first()).toBeVisible()
  })

  test("is usable at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 })
    await signUp(page)

    // The sidebar becomes a scrollable strip rather than eating half a narrow screen.
    await expect(page.locator(".ks-nav")).toBeHidden()
    await expect(page.locator(".ks-navstrip")).toBeVisible()

    // Nothing may overflow horizontally: a page that scrolls sideways on a phone is broken
    // whatever it looks like in a screenshot.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })

  test("renders the prebuilt auth forms as the app's own fields, not browser defaults", async ({ page }) => {
    // Needs no session and no seed, so it also runs against `vite` on its own.
    await page.goto("/", { waitUntil: "networkidle" })
    await expectStyledForm(page, "sign-up", 'input[type="email"]')
    await page.getByRole("button", { name: /already have an account/i }).click()
    await expectStyledForm(page, "sign-in", 'input[type="email"]')
  })

  test("offers a password reset and an emailed sign-in link from signing in, styled the same", async ({ page }) => {
    // Vite-only too: these render and validate in the browser before any request is made.
    await page.goto("/", { waitUntil: "networkidle" })
    await page.getByRole("button", { name: /already have an account/i }).click()
    await expectSameLook(page, ["Forgot password?", "Email me a sign-in link", "Need an account? Sign up"])

    await page.getByRole("button", { name: "Forgot password?" }).click()
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible()
    await expect(page.getByLabel("Email address")).toBeVisible()
    await expectStyledForm(page, "forgot password", 'input[type="email"]')
    await page.getByRole("button", { name: "Back to sign in" }).click()

    await page.getByRole("button", { name: "Email me a sign-in link" }).click()
    await expect(page.getByRole("heading", { name: "Sign in with a magic link" })).toBeVisible()
    await expectStyledForm(page, "magic link", 'input[type="email"]')
    await page.getByRole("button", { name: "Back to sign in" }).click()
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible()
  })

  test("lands a password reset link on a styled new-password form, not the conference", async ({ page }) => {
    // The auth server is stood in for, so this runs against `vite` with no stack: a reset link
    // arrives with implicit-grant tokens and `type=recovery` in the fragment, the client fetches the
    // user for them, and then emits PASSWORD_RECOVERY, which is what the app keys on.
    const updates: unknown[] = []
    await page.route("**/auth/v1/user", async (route) => {
      if (route.request().method() === "PUT") updates.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RECOVERED_USER) })
    })
    await page.goto(`/#${RECOVERY_FRAGMENT}`, { waitUntil: "networkidle" })

    await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Programme", exact: true })).toHaveCount(0)
    expect(page.url(), "the tokens leave the address bar").not.toContain("access_token")
    await expectStyledForm(page, "update password", 'input[type="password"]')

    await page.getByLabel("New password").fill(PASSWORD)
    await page.getByRole("button", { name: "Update password" }).click()
    await expect(page.getByText("Your password has been updated.")).toBeVisible()
    expect(updates).toEqual([{ password: PASSWORD }])
  })
})

/** What `/auth/v1/user` answers for the user a reset link signed in. */
const RECOVERED_USER = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "reset@example.com",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  app_metadata: { provider: "email" },
  user_metadata: {},
}

/** The fragment a reset link lands with: the auth server's implicit grant, marked as a recovery. */
const RECOVERY_FRAGMENT = new URLSearchParams({
  access_token: "recovery-access-token",
  refresh_token: "recovery-refresh-token",
  expires_in: "3600",
  token_type: "bearer",
  type: "recovery",
}).toString()

/**
 * The auth card's form drawn with the app's own fields.
 *
 * The forms ship no stylesheet. Unstyled, the label sits inline beside a narrow square input and the
 * button is the browser's grey one; the card around them gives no hint of that.
 */
async function expectStyledForm(page: Page, mode: string, inputSelector: string): Promise<void> {
  const card = page.locator(".ks-card").first()
  const input = card.locator(inputSelector)
  const submit = card.locator('button[type="submit"]')
  await expect(input, mode).toBeVisible()
  await expect(card.locator("label").first(), mode).toHaveCSS("display", "block")
  await expect(card.locator("h2").first(), mode).toHaveCSS("font-size", "17px")
  await expect(input, mode).toHaveCSS("border-radius", "8px")
  const widths = await Promise.all([input, card].map((l) => l.evaluate((el) => el.clientWidth)))
  expect(widths[0], `${mode}: input fills the card`).toBeGreaterThan((widths[1] ?? 0) * 0.8)
  await expect(submit, mode).toHaveCSS("background-color", await accentColor(page))
}

/**
 * The alternative actions under the card drawn alike: one variant, one resting background.
 *
 * The pointer is moved off first. The click that opened the screen leaves it over whichever button
 * now sits there, and a hovered ghost button is filled, which is the hover state and not a mismatch.
 */
async function expectSameLook(page: Page, names: string[]): Promise<void> {
  await page.mouse.move(0, 0)
  const looks = await Promise.all(
    names.map((name) =>
      page.getByRole("button", { name, exact: true }).evaluate((el) => `${el.className} | ${getComputedStyle(el).backgroundColor}`),
    ),
  )
  expect(new Set(looks).size, looks.join(" / ")).toBe(1)
}

/** `--ks-accent` as the browser computes it, so the assertion follows the theme. */
async function accentColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("span")
    probe.style.color = "var(--ks-accent)"
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
}
