import { expect, test, type Page, type Route } from "@playwright/test"

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

  test("shows a speaker's photo from the reference the column stores", async ({ page }) => {
    // Stubbed, so it runs against `vite` with no stack. The column holds `{ bucket, path }` and no
    // URL; the screen used to read a `url` field that is never there, so every photo was initials.
    await openStubbedSpeakers(page, HEADSHOT_SPEAKER)
    const photo = page.locator(".ks-avatar img")
    await expect(photo).toHaveCount(1)
    const origin = new URL(page.url()).origin
    await expect(photo).toHaveAttribute(
      "src",
      `${origin}/storage/v1/object/public/speaker-headshots/avatars/ada.jpg?width=104&height=104&format=webp&resize=cover`,
    )
    await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  })

  test("refuses a message the schema refuses, and says what to change", async ({ page }) => {
    await signUp(page)
    await open(page, "Lobby")

    const box = page.getByLabel("Message")
    const note = page.locator(".ks-note--error")

    // The model constraint `Gte<Length<"body">, Literal<2>>`, which the lobby checks before sending.
    await box.fill("x")
    await page.getByRole("button", { name: "Send" }).click()
    await expect(note).toContainText(/at least 2 characters/i)
    await expect(note).not.toContainText(/violates|constraint/i)

    // The validator's rule, also checked first, in the validator's own words.
    await box.fill("HELLO EVERYONE AT THIS CONFERENCE")
    await page.getByRole("button", { name: "Send" }).click()
    await expect(note).toContainText(/shouting|lower case/i)
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

type Respond = (route: Route) => Promise<void>

/** Answer a refused write the way the stack does: the bodies here were captured from it. */
function refuseWith(status: number, body: Record<string, unknown>): Respond {
  return (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

/** The write accepted, for the tests that expect it never to be made. */
const accept: Respond = (route) => route.fulfill({ status: 201, contentType: "application/json", body: "[]" })

const SERVER_REFUSALS: { what: string; respond: Respond; shows: RegExp; logs?: string }[] = [
  {
    what: "a check constraint (23514)",
    respond: refuseWith(400, {
      code: "23514",
      details: null,
      hint: null,
      message: 'new row for relation "chat_message" violates check constraint "chat_message_body_min_length"',
    }),
    shows: /between 2 and 500 characters/i,
    logs: "chat_message_body_min_length",
  },
  {
    what: "a permission refusal (42501)",
    respond: refuseWith(403, { code: "42501", details: null, hint: null, message: "permission denied for table chat_message" }),
    shows: /not allowed to post/i,
    logs: "permission denied",
  },
  {
    what: "a validator refusal",
    respond: refuseWith(422, { field: "body", message: "Say something kinder.", error: "Say something kinder." }),
    shows: /say something kinder/i,
  },
  { what: "a network failure", respond: (route) => route.abort("internetdisconnected"), shows: /connection/i },
]

test.describe("the kitchen-sink lobby composer", () => {
  // Vite-only: the auth server and the REST API are stood in for, so these run with no stack.
  test("stops a one-character message before sending it", async ({ page }) => {
    const sent = await openStubbedLobby(page)
    await page.getByLabel("Message").fill("x")
    await page.getByRole("button", { name: "Send" }).click()

    await expect(page.locator(".ks-note--error")).toContainText(/at least 2 characters/i)
    expect(sent, "nothing reached the API").toEqual([])
  })

  test("stops a message over 500 characters before sending it", async ({ page }) => {
    const sent = await openStubbedLobby(page)
    await page.getByLabel("Message").fill("a".repeat(501))
    await page.getByRole("button", { name: "Send" }).click()

    await expect(page.locator(".ks-note--error")).toContainText(/500 characters/i)
    expect(sent).toEqual([])
  })

  for (const refusal of SERVER_REFUSALS) {
    test(`explains ${refusal.what} without the server's wording`, async ({ page }) => {
      const logged: string[] = []
      page.on("console", (m) => { if (m.type() === "error") logged.push(m.text()) })
      const sent = await openStubbedLobby(page, refusal.respond)
      await page.getByLabel("Message").fill("hello lobby")
      await page.getByRole("button", { name: "Send" }).click()

      const note = page.locator(".ks-note--error")
      await expect(note).toContainText(refusal.shows)
      await expect(note).not.toContainText(/chat_message|violates|permission denied|Failed to fetch/i)
      expect(sent).toHaveLength(1)
      // The developer still gets the raw error, in the console rather than on the screen.
      if (refusal.logs !== undefined) expect(logged.join("\n")).toContain(refusal.logs)
    })
  }
})

/**
 * Signed in and on the lobby with no stack behind it.
 *
 * A magic-link fragment gives the client a session, `/auth/v1/user` answers for it, and every read
 * returns no rows. Returns the chat messages the page tried to write, answered by `respond`.
 */
async function openStubbedLobby(page: Page, respond: Respond = accept): Promise<unknown[]> {
  const sent: unknown[] = []
  await stubSignedInUser(page)
  await page.route("**/rest/v1/**", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    sent.push(route.request().postDataJSON())
    return respond(route)
  })
  await page.goto(`/#${SIGNED_IN_FRAGMENT}`, { waitUntil: "networkidle" })
  await open(page, "Lobby")
  return sent
}

/** `/auth/v1/user` answering for the session a magic-link fragment hands the client. */
async function stubSignedInUser(page: Page): Promise<void> {
  await page.route("**/auth/v1/user", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RECOVERED_USER) }),
  )
}

/** A published speaker whose headshot column holds what an upload stores: a bucket and a path. */
const HEADSHOT_SPEAKER = {
  id: "00000000-0000-4000-8000-0000000000a1",
  name: "Ada Buckley",
  slug: "ada-buckley",
  bio: { en: "Writes compilers." },
  headshot: { bucket: "speaker-headshots", path: "avatars/ada.jpg", mimeType: "image/jpeg", size: 812 },
  links: null,
  email: null,
  published_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
}

/**
 * Signed in and on the speakers screen with no stack behind it: the speaker table answers with
 * `speaker`, every other read with no rows, and every public object with a real JPEG.
 */
async function openStubbedSpeakers(page: Page, speaker: typeof HEADSHOT_SPEAKER): Promise<void> {
  await stubSignedInUser(page)
  await page.route("**/rest/v1/**", (route) => {
    const isSpeaker = new URL(route.request().url()).pathname.endsWith("/rest/v1/speaker")
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(isSpeaker ? [speaker] : []) })
  })
  await page.route("**/storage/v1/object/public/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/jpeg", body: AVATAR_JPEG }),
  )
  await page.goto(`/#${SIGNED_IN_FRAGMENT}`, { waitUntil: "networkidle" })
  await open(page, "Speakers")
}

/**
 * A 24x24 JPEG, small enough to inline. A real one matters: the transform has to decode it.
 */
const AVATAR_JPEG = Buffer.from(
  "/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAYABgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAL/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAIG/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AkBLNAAAAAAP/2Q==",
  "base64",
)

/**
 * Signs in as `E2E_KS_EMAIL` / `E2E_KS_PASSWORD` when both are set, otherwise signs up a fresh
 * attendee. A stack with email confirmation on gives a new sign-up no session, so the account tests
 * need an existing, confirmed user there.
 */
async function signInForAccount(page: Page): Promise<void> {
  const email = process.env.E2E_KS_EMAIL
  const password = process.env.E2E_KS_PASSWORD
  if (email === undefined || password === undefined) {
    await signUp(page)
    return
  }
  await page.goto("/", { waitUntil: "networkidle" })
  await page.getByRole("button", { name: /already have an account/i }).click()
  await page.locator('input[type="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(password)
  await page.getByRole("button", { name: /^sign in$/i }).click()
  await expect(page.getByRole("button", { name: "Programme", exact: true })).toBeVisible({ timeout: 30_000 })
}

/** Fetch an image URL from the page and say what came back. */
async function fetched(page: Page, url: string): Promise<{ status: number; type: string; bytes: number }> {
  return page.evaluate(async (u) => {
    const res = await fetch(u)
    return { status: res.status, type: res.headers.get("content-type") ?? "", bytes: (await res.arrayBuffer()).byteLength }
  }, url)
}

test.describe("the kitchen-sink account screen", () => {
  test("stores the picked picture's bytes and serves both the original and the transform", async ({ page }) => {
    // Manual testing found an avatar stored as 0 bytes whose transform answered 500. Both URLs
    // returning image bytes is the whole point of this screen.
    await signInForAccount(page)
    await open(page, "Account")
    await page.getByLabel("Choose a picture").setInputFiles({ name: "avatar.jpg", mimeType: "image/jpeg", buffer: AVATAR_JPEG })

    const original = page.getByAltText("the bytes that were uploaded")
    const transformed = page.getByAltText("resized and re-encoded on read")
    await expect(original).toBeVisible()

    const asUploaded = await fetched(page, (await original.getAttribute("src")) ?? "")
    expect(asUploaded).toEqual({ status: 200, type: "image/jpeg", bytes: AVATAR_JPEG.length })
    const derived = await fetched(page, (await transformed.getAttribute("src")) ?? "")
    expect(derived.status).toBe(200)
    expect(derived.type).toBe("image/webp")
    expect(derived.bytes).toBeGreaterThan(0)
    // Decoded by the browser, not merely fetched. 24px, not 160: the transform never enlarges.
    await expect.poll(() => transformed.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  })

  test("refuses an empty file instead of storing it", async ({ page }) => {
    await signInForAccount(page)
    await open(page, "Account")
    const uploads: string[] = []
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/storage/v1/object/")) uploads.push(r.url())
    })
    await page.getByLabel("Choose a picture").setInputFiles({ name: "test.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(0) })
    await expect(page.getByText("test.jpg is empty (0 bytes). Choose another picture.")).toBeVisible()
    expect(uploads).toEqual([])
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

/** A magic link's fragment: the same implicit grant, signing the user straight in. */
const SIGNED_IN_FRAGMENT = new URLSearchParams({
  access_token: "magic-access-token",
  refresh_token: "magic-refresh-token",
  expires_in: "3600",
  token_type: "bearer",
  type: "magiclink",
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
