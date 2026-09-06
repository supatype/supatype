import { expect, test, type Page } from "@playwright/test"

/**
 * The three groups of views Studio is for: models, the database, and auth.
 *
 * Each is asserted on content that had to come from the server, in the element
 * that would hold it. A view rendering its chrome and an empty body is the
 * failure worth catching, and it looks identical to a working one to any test
 * that only checks the heading is there or that some string appears anywhere on
 * the page — the sidebar alone contains "Users", "Email" and every model name.
 */
const EMAIL = process.env.STUDIO_E2E_EMAIL ?? "studio-e2e@example.com"
const PASSWORD = process.env.STUDIO_E2E_PASSWORD ?? "StudioE2E123!"

/** Requests the page could not make at all, or that failed on the server. */
function watchFailures(page: Page): string[] {
  const failures: string[] = []
  page.on("requestfailed", (r) => failures.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`))
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

async function signIn(page: Page): Promise<void> {
  await page.goto("/studio/", { waitUntil: "networkidle" })
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  // Wait for the session to be *stored*, not merely for the request to return.
  // Navigating between those two moments loses it, and every later view then
  // shows the sign-in page, which reads as "the view is broken".
  await page.waitForFunction(() => localStorage.getItem("supatype.auth.session") !== null, null, {
    timeout: 30_000,
  })
}

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

    // The selected model's own grid, with its columns rather than any table.
    const grid = page.locator("table").first()
    await expect(grid).toBeVisible()
    await expect(grid).toContainText(/email/i)
    await expect(grid).toContainText(/role/i)
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

  test("auth: providers lists each one with its enabled state", async ({ page }) => {
    const failures = watchFailures(page)
    await page.goto("/studio/authentication/providers", { waitUntil: "networkidle" })

    const main = page.locator("main, [role='main']").first()
    for (const provider of ["Github", "Google", "Gitlab", "Discord"]) {
      await expect(main).toContainText(new RegExp(provider, "i"))
    }
    // Each row offers the action for its current state, which only renders once
    // the current configuration has been read.
    await expect(main.getByRole("button", { name: /^enable$/i }).first()).toBeVisible()

    expect(failures, "requests that failed on the providers view").toEqual([])
  })

  test("auth: configuration shows the settings it can change", async ({ page }) => {
    const failures = watchFailures(page)
    await page.goto("/studio/authentication/configuration", { waitUntil: "networkidle" })

    const main = page.locator("main, [role='main']").first()
    await expect(main).toContainText(/jwt expiry/i)
    await expect(main).toContainText(/site url/i)
    await expect(main).toContainText(/session timeout/i)
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
