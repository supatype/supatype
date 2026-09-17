import { expect, test } from "@playwright/test"

/**
 * Creating a record on a versioned model leaves a first draft behind.
 *
 * It did not. `createDraft` was wired into the update path only, so a new record was written to the
 * live row with no version at all: its history was empty, and a preview link minted against it
 * resolved correctly and found nothing, telling the reader "no draft to preview" about a record
 * that plainly had content. A record had to be saved twice before it could be previewed once.
 *
 * Driven through the browser rather than by calling `supatype.create_draft`, because the RPC was
 * never the broken part. What broke was whether anything called it, and only the real save path
 * answers that.
 */
const EMAIL = process.env.STUDIO_E2E_EMAIL ?? "studio-e2e@example.com"
const PASSWORD = process.env.STUDIO_E2E_PASSWORD ?? "StudioE2E123!"

test("creating a post leaves a first draft", async ({ page }) => {
  await page.goto("/studio/", { waitUntil: "networkidle" })
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  // Wait for the session to be stored, not merely for the request to return: navigating between
  // those two moments loses it and every later view shows the sign-in page.
  await page.waitForFunction(() => localStorage.getItem("supatype.auth.session") !== null, null, {
    timeout: 30_000,
  })

  const title = `draft-on-create-${Date.now()}`
  await page.goto("/studio/models/Post/create", { waitUntil: "networkidle" })
  await page.getByLabel(/^title/i).fill(title)

  // `body` is a required localized rich text field, so a title alone cannot be saved.
  const body = page.locator('[contenteditable="true"]').first()
  await body.click()
  await body.fill("Body written by the create-draft check.")

  await page.getByRole("button", { name: /^save$/i }).click()

  // The form navigates to the record once the row exists, which is the signal that the save
  // finished rather than that the button was pressed.
  await page.waitForURL(/\/studio\/models\/Post\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  const recordId = page.url().split("/").pop() ?? ""
  expect(recordId).toMatch(/^[0-9a-f-]{36}$/)

  // The record's own history is where the draft has to show up. Asserting on the publish bar alone
  // would pass on a record with no versions at all, since it reports "Not published" either way.
  await page.goto(`/studio/models/Post/${recordId}/versions`, { waitUntil: "networkidle" })
  await expect(page.getByText(/draft/i).first()).toBeVisible({ timeout: 15_000 })
})
