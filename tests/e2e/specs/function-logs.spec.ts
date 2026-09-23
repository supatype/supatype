import { expect, test, type Page } from "@playwright/test"

/**
 * The Logs tab on a function, driven as a person drives it.
 *
 * This is the one part of the function-log chain nothing else covers. The worker's output, the
 * server's relay and the stream parser each have their own tests, and all of them pass against a
 * tab that renders its chrome over an empty table — which is exactly what shipped before, with
 * "coming soon" in it.
 *
 * # The two deployment shapes, and why the test knows about both
 *
 * Logs reach Studio by one of two routes, decided by where the functions actually run:
 *
 *   - **an external worker** (Compose, cloud): the worker streams, the server relays it on
 *     `/functions/v1/admin/logs/tail`, and the tab tails live.
 *   - **in-process Deno** (`supatype dev`): there is no worker to tail, the relay answers 501, and
 *     the tab falls back to the per-function query the server answers from its own log buffer.
 *
 * Both are real and both ship. Asserting only one would leave the other free to break, and this
 * harness happens to run the second, so a test written for the tail alone would pass by never
 * exercising anything. So the spec establishes which shape it is from the response the tab gets,
 * then asserts the behaviour that shape owes.
 */
const EMAIL = process.env.STUDIO_E2E_EMAIL ?? "studio-e2e@example.com"
const PASSWORD = process.env.STUDIO_E2E_PASSWORD ?? "StudioE2E123!"

/** A function the integration project defines, and which logs when invoked. */
const FUNCTION = process.env.STUDIO_E2E_FUNCTION ?? "echo"

async function signIn(page: Page): Promise<void> {
  await page.goto("/studio/", { waitUntil: "networkidle" })
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  // Wait for the session to be stored, not merely for the request to return: navigating between
  // those two moments loses it and every later view shows the sign-in page.
  await page.waitForFunction(() => localStorage.getItem("supatype.auth.session") !== null, null, {
    timeout: 30_000,
  })
}

/**
 * Open the tab and report which route served it, taken from the response rather than assumed.
 *
 * The wait is armed before the navigation, because the request goes out as the tab mounts and a
 * wait registered afterwards has already missed it.
 *
 * `domcontentloaded`, not `networkidle`: when the tail is supported this page holds an event stream
 * open for as long as it is on screen, so the network is never idle and that wait cannot return.
 */
async function openLogsTab(page: Page, fn: string): Promise<boolean> {
  const tail = page.waitForResponse((r) => r.url().includes("/functions/v1/admin/logs/tail"), {
    timeout: 20_000,
  })
  await page.goto(`/studio/edge-functions/${fn}/logs`, { waitUntil: "domcontentloaded" })
  return (await tail).status() !== 501
}

test.describe("function logs", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test("the logs tab shows what a function logged when it was invoked", async ({ page, request }) => {
    const supported = await openLogsTab(page, FUNCTION)

    if (supported) {
      // The stream is open before anything is invoked, so the line has to arrive live.
      await expect(page.getByText(/^Live$/)).toBeVisible()
    } else {
      // The fallback says so rather than showing an empty table, which is the failure this whole
      // feature existed to remove.
      await expect(page.getByText(/runs functions in the server process/i)).toBeVisible()
    }

    // Invoke it. Through `request` rather than the page, so the call is not confused with Studio's
    // own traffic and does not need the browser's session.
    const invoked = await request.get(`/functions/v1/${FUNCTION}`, {
      headers: { apikey: process.env.SUPATYPE_ANON_KEY ?? "" },
      failOnStatusCode: false,
    })
    expect(invoked.status(), "the function has to run before it can have logged").toBeLessThan(500)

    if (!supported) {
      // The query route is polled, so ask for it again rather than waiting on a stream.
      await page.getByRole("button", { name: /refresh/i }).click()
    }

    // The table, specifically. A test that looked for the function's name anywhere on the page
    // would pass on the sidebar entry alone.
    const rows = page.locator("table tbody tr")
    await expect(rows.first()).toBeVisible({ timeout: 30_000 })
    // Something a server produced, in the cell that holds it: a timestamp that parses.
    const firstTimestamp = await rows.first().locator("td").first().innerText()
    expect(Number.isNaN(Date.parse(firstTimestamp))).toBe(false)
  })

  test("the tab does not present raw JSON as a log message", async ({ page, request }) => {
    // The router emits structured JSON so cloud's pipeline can label each line. Both paths have to
    // unpack it: the relay passes it through as an object, and the in-process reader parses it. A
    // regression in either shows a whole JSON document where the message belongs, and every other
    // test still passes because the row is present and the timestamp is real.
    const supported = await openLogsTab(page, FUNCTION)

    await request.get(`/functions/v1/${FUNCTION}`, {
      headers: { apikey: process.env.SUPATYPE_ANON_KEY ?? "" },
      failOnStatusCode: false,
    })
    if (!supported) await page.getByRole("button", { name: /refresh/i }).click()

    const rows = page.locator("table tbody tr")
    await expect(rows.first()).toBeVisible({ timeout: 30_000 })

    const messages = await rows.locator("td").nth(2).allInnerTexts()
    for (const message of messages) {
      expect(message.trim().startsWith("{"), `message rendered as raw JSON: ${message}`).toBe(false)
    }
  })
})
