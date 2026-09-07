import { expect, test, type Page } from "@playwright/test"

/**
 * The Media & Storage section, which nothing covered.
 *
 * The other view specs describe themselves as "the three groups of views Studio is for: models, the
 * database, and auth". Storage was not among them, and it broke without anything noticing: every
 * storage request carried the anon key rather than the caller's session, because the storage client
 * was handed a plain headers object built before anybody had signed in. Through Studio's proxy that
 * is refused — an anon key has no `sub` — so the bucket list read
 * `{"error":"Token missing subject claim"}`.
 *
 * The client has a unit test for what it sends now. This is here because that test passes against a
 * Studio whose storage section renders nothing at all: only driving it catches the section being
 * empty, and only driving it against a real gateway catches the proxy refusing the request.
 */
const EMAIL = process.env.STUDIO_E2E_EMAIL ?? "studio-e2e@example.com"
const PASSWORD = process.env.STUDIO_E2E_PASSWORD ?? "StudioE2E123!"

async function signIn(page: Page): Promise<void> {
  await page.goto("/studio/", { waitUntil: "networkidle" })
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  await page.waitForFunction(() => localStorage.getItem("supatype.auth.session") !== null, null, {
    timeout: 30_000,
  })
}

test.describe("media and storage", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test("the buckets the storage service reports are listed", async ({ page }) => {
    // Every storage response the page receives, so a refusal is caught even when the view renders
    // its chrome over an empty list and looks merely empty.
    const refusals: string[] = []
    page.on("response", async (r) => {
      if (!r.url().includes("/storage/v1/")) return
      if (r.status() < 400) return
      refusals.push(`${r.status()} ${r.url()}`)
    })

    await page.goto("/studio/media-storage", { waitUntil: "networkidle" })

    expect(refusals, "storage refused a request the page made").toEqual([])

    // Watching the responses is the load-bearing half. `SecondaryPanel` swallows a storage error
    // with `if (error) return []`, so a refused request renders as an empty list rather than as a
    // message: a test looking for the error text on the page passes while the section is broken.
    //
    // A bucket name had to come from the storage service: it is in no fixture and no menu.
    const buckets = page.getByText(/post-attachments|post-covers|user-avatars/)
    await expect(buckets.first()).toBeVisible({ timeout: 20_000 })
  })

})
