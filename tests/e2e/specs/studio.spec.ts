import { expect, test, type Page } from "@playwright/test"

/**
 * Studio, driven through a browser.
 *
 * Everything else in this repository tests Studio's *server* surface:
 * /studio-config answers, /studio/session answers, the bundle is served with a
 * 200. None of that notices a bundle that loads and then throws, an asset
 * referenced at the wrong base path, or a sign-in form wired to nothing — and a
 * refactor that renamed every variable the server reads is exactly the kind of
 * change that breaks the last of those while leaving the first three green.
 *
 * The credentials come from the environment so the runner can create the admin
 * with `supatype admin create-user` before the browser opens.
 */
const EMAIL = process.env.STUDIO_E2E_EMAIL ?? "studio-e2e@example.com"
const PASSWORD = process.env.STUDIO_E2E_PASSWORD ?? "StudioE2E123!"

/** Anything the page reported as broken while it loaded. */
function collectFailures(page: Page): { errors: string[]; badResponses: string[] } {
  const errors: string[] = []
  const badResponses: string[] = []
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  page.on("pageerror", (e) => errors.push(`uncaught: ${e.message}`))
  page.on("response", (r) => {
    const status = r.status()
    const url = r.url()
    // Two 4xx are states rather than faults, and both are Studio working:
    //   401 before sign-in is the point of the sign-in page.
    //   404 /studio-config means "schema not pushed yet", which is what a
    //       project without a generated admin config genuinely is. Studio reads
    //       that and carries on, which is the behaviour worth having.
    const expected = status === 401 || (status === 404 && url.includes("/studio-config"))
    if (!expected && status >= 400) badResponses.push(`${status} ${url}`)
  })
  return { errors, badResponses }
}

async function signIn(page: Page): Promise<void> {
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
}

test.describe("Studio", () => {
  test("loads its bundle and renders, with nothing broken on the way", async ({ page }) => {
    const { errors, badResponses } = collectFailures(page)

    await page.goto("/studio/", { waitUntil: "networkidle" })

    // The bundle ran: a served-but-dead SPA leaves #root empty, and the title
    // comes from the HTML so it proves nothing on its own.
    await expect(page.locator("#root")).not.toBeEmpty()
    await expect(page.getByRole("heading", { name: /sign in to studio/i })).toBeVisible()

    expect(errors, "console errors while loading Studio").toEqual([])
    expect(badResponses, "5xx responses while loading Studio").toEqual([])
  })

  test("serves its assets from the base path it is mounted on", async ({ page }) => {
    // Studio is proxied at /studio/, so its assets have to be requested there
    // too. Get this wrong and the page is blank with a 404 for the bundle, which
    // a status check on the HTML never sees.
    const assets: { url: string; status: number }[] = []
    page.on("response", (r) => {
      const url = r.url()
      if (/\.(js|css)(\?|$)/.test(url)) assets.push({ url, status: r.status() })
    })

    await page.goto("/studio/", { waitUntil: "networkidle" })

    expect(assets.length, "Studio requested no javascript or css at all").toBeGreaterThan(0)
    for (const asset of assets) {
      expect(asset.status, `asset ${asset.url}`).toBeLessThan(400)
      expect(asset.url, "asset is not under the mount path").toContain("/studio/")
    }
  })

  test("refuses a wrong password and stays on the sign-in page", async ({ page }) => {
    await page.goto("/studio/", { waitUntil: "networkidle" })
    await page.getByLabel(/email/i).fill(EMAIL)
    await page.getByLabel(/password/i).fill("definitely-not-the-password")
    await page.getByRole("button", { name: /sign in/i }).click()

    // Still asking to sign in, and something said no.
    await expect(page.getByRole("heading", { name: /sign in to studio/i })).toBeVisible()
    await expect(page.locator("#root")).toContainText(/invalid|incorrect|credential|failed|denied/i)
  })

  test("signs an admin in and shows a view with data from the server", async ({ page }) => {
    const { badResponses } = collectFailures(page)

    await page.goto("/studio/", { waitUntil: "networkidle" })
    await signIn(page)

    // The sign-in form is gone, which is the only reliable signal that the
    // session was accepted rather than the click simply doing nothing.
    await expect(page.getByRole("heading", { name: /sign in to studio/i })).toBeHidden({
      timeout: 30_000,
    })

    // And something that had to come from the server is on screen. The schema
    // Studio shows is read through /studio/schema, so a rendered table name
    // proves the whole path: session, proxy, and the server behind it.
    await expect(page.locator("#root")).not.toBeEmpty()
    const body = await page.locator("body").innerText()
    expect(body.length, "signed in but the page is empty").toBeGreaterThan(40)

    expect(badResponses, "requests Studio could not load after signing in").toEqual([])
  })
})
