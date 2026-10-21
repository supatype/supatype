import { expect, test, type Locator, type Page } from "@playwright/test"
import { isRecord } from "../lib/json.js"
import { signInToStudio } from "../lib/studio-session.js"

/**
 * The three groups of views Studio is for: models, the database, and auth.
 *
 * Each is asserted on content that had to come from the server, in the element
 * that would hold it. A view rendering its chrome and an empty body is the
 * failure worth catching, and it looks identical to a working one to any test
 * that only checks the heading is there or that some string appears anywhere on
 * the page: the sidebar alone contains "Users", "Email" and every model name.
 */
const EMAIL = process.env.STUDIO_E2E_EMAIL ?? "studio-e2e@example.com"
const PASSWORD = process.env.STUDIO_E2E_PASSWORD ?? "StudioE2E123!"

/**
 * A request the browser cancelled, rather than one that failed.
 *
 * Playwright reports both through `requestfailed`, and they are not the same event. A view that
 * fires a count and then re-renders leaves that count in flight, and the browser aborts it. Nothing
 * failed: no server saw it, and the page had already decided it did not want the answer. Counting
 * it made every assertion below depend on whether a render landed before or after a HEAD request,
 * which is a race, and it failed as one.
 */
const CANCELLED = "net::ERR_ABORTED"

/** Requests the page could not make at all, or that failed on the server. */
function watchFailures(page: Page): string[] {
  const failures: string[] = []
  page.on("requestfailed", (r) => {
    const reason = r.failure()?.errorText
    if (reason === CANCELLED) return
    failures.push(`${r.method()} ${r.url()} :: ${reason}`)
  })
  page.on("response", (r) => {
    const status = r.status()
    const url = r.url()
    // 401 before sign-in is the sign-in page working; 404 /studio-config means
    // "schema not pushed yet", which is a state rather than a fault.
    if (status >= 400 && status !== 401 && !url.includes("/studio-config")) {
      failures.push(`${status} ${url}`)
    }
  })
  return failures
}

const signIn = (page: Page): Promise<void> =>
  signInToStudio(page, { email: EMAIL, password: PASSWORD })

/** An address no earlier run created, so a leftover user cannot satisfy an assertion. */
const newUserEmail = (label: string): string => `studio-${label}-${Date.now()}@example.com`

/**
 * Create a user from the users view with Auto-confirm email set as asked.
 *
 * Set explicitly rather than left at its default, because the default follows the project's own
 * email confirmation setting, which is a property of the stack and not of this test.
 */
async function createUser(page: Page, email: string, autoConfirm: boolean): Promise<void> {
  await page.goto("/studio/authentication/users", { waitUntil: "networkidle" })
  await page.getByRole("button", { name: "+ Create User" }).click()

  const panel = page.getByRole("dialog")
  await panel.locator("input").first().fill(email)
  await panel.locator("input[type='password']").fill("StudioUser123!")
  const checkbox = panel.getByLabel("Auto-confirm email")
  await expect(checkbox).toBeVisible()
  await checkbox.setChecked(autoConfirm)

  const created = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/auth/v1/admin/users"),
  )
  await panel.getByRole("button", { name: "Create User", exact: true }).click()
  expect((await created).status(), "POST /auth/v1/admin/users").toBeLessThan(300)
  await expect(page.locator("tbody tr", { hasText: email })).toBeVisible()
}

/** The Confirmed value in the open user's detail panel, rather than the list column behind it. */
const confirmedField = (page: Page): Locator =>
  page.getByRole("dialog").locator("label", { hasText: /^Confirmed$/ }).locator("xpath=following-sibling::span")

test.describe("Studio views", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test("the dashboard shows figures the server measured", async ({ page }) => {
    await page.goto("/studio/", { waitUntil: "networkidle" })
    await expect(page.locator("body")).toContainText(/database size/i)
    // A size Postgres reported, not a placeholder.
    await expect(page.locator("body")).toContainText(/\d+(\.\d+)?\s*(B|KB|MB|GB)/i)
  })

  // ── models ─────────────────────────────────────────────────────────────────

  test("models: the pushed schema's models are listed, with a row grid and tabs", async ({ page }) => {
    const failures = watchFailures(page)
    await page.goto("/studio/models", { waitUntil: "networkidle" })

    // Names that exist only because this project's schema was pushed.
    for (const model of ["Authors", "Posts", "Categories", "Comments"]) {
      await expect(page.getByText(new RegExp(`^${model}$`)).first()).toBeVisible()
    }

    // The selected model's own grid, with its columns rather than any table. A list shows the
    // primary key first and then the model's first two displayable fields, so `author` lists
    // Id, Email and Username, and `role` is on the record rather than in the list.
    const grid = page.locator("table").first()
    await expect(grid).toBeVisible()
    await expect(grid.locator("th").first()).toHaveText(/^id\b/i)
    await expect(grid).toContainText(/email/i)
    await expect(grid).toContainText(/username/i)
    await expect(page.getByRole("button", { name: /create author/i }).first()).toBeVisible()

    for (const tab of ["Schema", "Data", "API", "GraphQL"]) {
      await expect(page.getByText(new RegExp(`^${tab}$`)).first()).toBeVisible()
    }

    expect(failures, "requests that failed on the models view").toEqual([])
  })

  test("models: the schema tab names the model's own fields", async ({ page }) => {
    const failures = watchFailures(page)
    await page.goto("/studio/models/author/schema", { waitUntil: "networkidle" })

    // `email` is a field on Author. Asserted in the main region, because the
    // word appears in the sidebar of every auth view too.
    await expect(page.locator("main, [role='main']").first()).toContainText(/email/i)
    expect(failures, "requests that failed on the schema tab").toEqual([])
  })

  // ── database ───────────────────────────────────────────────────────────────

  test("database: tables are listed with the sizes Postgres reports", async ({ page }) => {
    const failures = watchFailures(page)
    await page.goto("/studio/database/tables", { waitUntil: "networkidle" })

    await expect(page.getByRole("heading", { name: /^tables$/i }).first()).toBeVisible()

    // The schema picker offers what introspection found, which is the part no
    // amount of chrome can fake. auth and storage are there because the stack
    // created them, not because this project declared them.
    //
    // Not graphql_public or pgbouncer, which an earlier version of this test
    // asserted: the picker lists only schemas holding base tables, and those
    // two hold none, so they can never appear however healthy the view is.
    const schemaPicker = page.locator("select").first()
    await expect(schemaPicker).toBeVisible()
    const offered = await schemaPicker.locator("option").allTextContents()
    expect(offered, "schemas the picker offers").toEqual(expect.arrayContaining(["public", "auth", "storage"]))

    // A row per table, carrying an on-disk size.
    const rows = page.locator("tbody tr")
    expect(await rows.count(), "no table rows at all").toBeGreaterThan(3)
    await expect(rows.filter({ hasText: /author/ }).first()).toContainText(/\d+(\.\d+)?\s*(B|KB|MB|GB)/i)

    expect(failures, "requests that failed on the tables view").toEqual([])
  })

  test("database: the SQL runner returns the rows the database computed", async ({ page }) => {
    const failures = watchFailures(page)
    await page.goto("/studio/database/sql", { waitUntil: "networkidle" })

    // The editor opens with a sample query, so clear it: appending would run
    // something else and the assertion below would pass on the wrong thing.
    const editor = page.locator("textarea, [contenteditable='true'], .cm-content").first()
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.press("Control+A")
    await page.keyboard.type("select 987654321 as answer")
    await page.getByRole("button", { name: /run query/i }).first().click()

    // In the results grid, not merely somewhere on the page: the query text is
    // still in the editor, so the number is present either way.
    const results = page.locator("table").first()
    await expect(results).toBeVisible({ timeout: 30_000 })
    await expect(results).toContainText(/answer/i)
    await expect(results).toContainText("987654321")

    expect(failures, "requests that failed running SQL").toEqual([])
  })

  // ── auth ───────────────────────────────────────────────────────────────────

  test("auth: the users view lists accounts from the auth service", async ({ page }) => {
    const failures = watchFailures(page)
    await page.goto("/studio/authentication/users", { waitUntil: "networkidle" })

    // The admin this test signed in as is a user, so it has to be listed. This
    // is the assertion that caught the view reading "Failed to fetch".
    await expect(page.locator("body")).toContainText(EMAIL, { timeout: 30_000 })
    await expect(page.locator("body")).not.toContainText(/failed to fetch/i)

    expect(failures, "requests that failed on the users view").toEqual([])
  })

  // The auth server confirms a user created through its admin API only when the request asks it to:
  // the project's auto-confirm setting covers public sign-ups, not this. Before the create form had
  // the checkbox, every user added in Studio sat unconfirmed with no way to confirm them from here.
  test("auth: a user created unconfirmed shows Pending, and Confirm email confirms them", async ({ page }) => {
    const failures = watchFailures(page)
    const email = newUserEmail("pending")
    await createUser(page, email, false)

    const row = page.locator("tbody tr", { hasText: email })
    await expect(row).toContainText("Pending")
    await row.locator("td").first().click()

    const panel = page.getByRole("dialog")
    await expect(confirmedField(page)).toHaveText("Pending")
    const confirmed = page.waitForResponse(
      (r) => r.request().method() === "PUT" && new URL(r.url()).pathname.includes("/auth/v1/admin/users/"),
    )
    await panel.getByRole("button", { name: "Confirm email", exact: true }).click()
    expect((await confirmed).status(), "PUT /auth/v1/admin/users/:id").toBe(200)
    await expect(confirmedField(page)).toHaveText("Yes")
    await expect(panel.getByRole("button", { name: "Confirm email", exact: true })).toHaveCount(0)

    // Read back from the auth server, not the panel's copy of the user: the URL still names the
    // user, so the reload reopens their detail from a fresh fetch.
    await page.reload({ waitUntil: "networkidle" })
    await expect(confirmedField(page)).toHaveText("Yes")
    await expect(page.locator("tbody tr", { hasText: email })).toContainText("Yes")

    expect(failures, "requests that failed creating and confirming a user").toEqual([])
  })

  test("auth: a user created with Auto-confirm email ticked is confirmed straight away", async ({ page }) => {
    const failures = watchFailures(page)
    const email = newUserEmail("autoconfirmed")
    await createUser(page, email, true)

    const row = page.locator("tbody tr", { hasText: email })
    await expect(row).toContainText("Yes")
    await row.locator("td").first().click()

    await expect(confirmedField(page)).toHaveText("Yes")
    await expect(page.getByRole("dialog").getByRole("button", { name: "Confirm email", exact: true })).toHaveCount(0)

    expect(failures, "requests that failed creating a confirmed user").toEqual([])
  })

  // Invite User used to create the user through the admin users API, which mails nothing, so the
  // invited person could never sign in. Only the invite endpoint sends the invitation link.
  test("auth: Invite User goes through the invite endpoint and lists the invited user as Pending", async ({ page }) => {
    const failures = watchFailures(page)
    const email = newUserEmail("invited")
    await page.goto("/studio/authentication/users", { waitUntil: "networkidle" })
    await page.getByRole("button", { name: "Invite User" }).click()

    const panel = page.getByRole("dialog")
    await panel.locator("input").first().fill(email)
    const invited = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/auth/v1/invite"),
    )
    await panel.getByRole("button", { name: "Send Invite", exact: true }).click()
    expect((await invited).status(), "POST /auth/v1/invite").toBeLessThan(300)
    await expect(page.locator("tbody tr", { hasText: email })).toContainText("Pending")

    expect(failures, "requests that failed inviting a user").toEqual([])
  })

  // Read-only for the same reason as the configuration page: each provider's state is what the auth
  // server reports, and the row says where it is set, because Studio has no way to change it.
  test("auth: providers lists each one with its enabled state", async ({ page }) => {
    const failures = watchFailures(page)
    const settings = page.waitForResponse((r) => new URL(r.url()).pathname === "/studio/proxy/auth/v1/settings")
    await page.goto("/studio/authentication/providers", { waitUntil: "networkidle" })
    const response = await settings
    expect(response.status(), "GET /studio/proxy/auth/v1/settings").toBe(200)
    const body: unknown = await response.json()
    const external = isRecord(body) && isRecord(body["external"]) ? body["external"] : {}

    // Sign-in methods the server reports beside the OAuth providers, which the page leaves out.
    const providers = Object.keys(external).filter((name) => !["email", "phone", "anonymous_users"].includes(name))
    expect(providers, "OAuth providers the auth server reports").toEqual(expect.arrayContaining(["github", "google"]))

    const main = page.locator("main, [role='main']").first()
    await expect(main.getByRole("columnheader", { name: "Set by" })).toBeVisible()
    for (const name of providers) {
      const row = main.getByRole("row", { name: new RegExp(`^${name}\\b`) })
      await expect(row).toContainText(external[name] ? "Enabled" : "Disabled")
      await expect(row).toContainText(`auth.providers.${name}`)
      await expect(row).toContainText(`SUPATYPE_EXTERNAL_${name.toUpperCase()}_ENABLED`)
    }

    // A button here could only change the page's own state, which is what this page used to do.
    await expect(main.getByRole("button", { name: /enable|disable|configure|save/i })).toHaveCount(0)
    await expect(main.locator("input, textarea, select")).toHaveCount(0)

    expect(failures, "requests that failed on the providers view").toEqual([])
  })

  // Read-only by decision: the page shows what the auth server reports and where each value is
  // set, because no host has a route that changes these from Studio. A form here could only
  // pretend to save, so a Save button or an input on this page is a regression.
  test("auth: configuration shows the server's settings and where each is set", async ({ page }) => {
    const failures = watchFailures(page)
    const settings = page.waitForResponse((r) => new URL(r.url()).pathname === "/studio/proxy/auth/v1/settings")
    await page.goto("/studio/authentication/configuration", { waitUntil: "networkidle" })
    expect((await settings).status(), "GET /studio/proxy/auth/v1/settings").toBe(200)

    const main = page.locator("main, [role='main']").first()
    await expect(main.getByRole("heading", { name: "Sign-up and confirmation" })).toBeVisible()
    await expect(main.getByRole("heading", { name: "Sign-in methods" })).toBeVisible()
    await expect(main.getByRole("columnheader", { name: "Set by" })).toHaveCount(2)
    // A sign-up row and a sign-in row, each naming the variable that sets it.
    await expect(main.getByRole("row", { name: /^New signups/ })).toContainText("DISABLE_SIGNUP")
    await expect(main.getByRole("row", { name: /^email\b/ })).toContainText("SUPATYPE_EXTERNAL_EMAIL_ENABLED")

    await expect(main.getByRole("button", { name: /save/i })).toHaveCount(0)
    await expect(main.locator("input, textarea, select")).toHaveCount(0)
    await expect(page.locator("body")).not.toContainText(/failed to fetch/i)

    expect(failures, "requests that failed on the configuration view").toEqual([])
  })

  test("auth: policies shows the RLS the database actually has", async ({ page }) => {
    const failures = watchFailures(page)
    await page.goto("/studio/authentication/policies", { waitUntil: "networkidle" })

    const main = page.locator("main, [role='main']").first()
    // A policy name and command read out of pg_policies, which no amount of
    // chrome can produce.
    await expect(main).toContainText(/author/i)
    await expect(main).toContainText(/PERMISSIVE|RESTRICTIVE/)
    await expect(main).toContainText(/SELECT|INSERT|UPDATE|DELETE/)

    expect(failures, "requests that failed on the policies view").toEqual([])
  })
})
