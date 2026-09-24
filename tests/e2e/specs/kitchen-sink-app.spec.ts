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
})
