import { expect, test } from "@playwright/test"

/**
 * Replication, Warehouse, Backups, SSO and AI Usage are not built anywhere, Cloud included.
 *
 * Self-hosted Studio used to badge them "Cloud" and title them "Available on Supatype Cloud", which
 * told somebody running their own stack that the hosted product had features it did not. They are
 * listed now as every other unbuilt entry is: present, inert, and saying they are coming.
 *
 * Driven in demo mode, which renders the same navigation with no platform attached (exactly what a
 * self-hosted Studio has) and needs no signed-in account, so it runs against any Studio build.
 */
const DEMO_SESSION_KEY = "supatype_studio_demo"

const ENTRIES = [
  { section: "/studio/database/overview", label: "Replication", note: "Read replicas are coming soon" },
  { section: "/studio/database/overview", label: "Warehouse", note: "The analytical warehouse is coming soon" },
  { section: "/studio/database/overview", label: "Backups", note: "Managed backups are coming soon" },
  { section: "/studio/authentication/users", label: "SSO", note: "SSO is coming soon" },
  { section: "/studio/ai/vectors", label: "Usage", note: "AI usage tracking is coming soon" },
]

test.describe("features that are not built yet", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((key) => sessionStorage.setItem(key, "1"), DEMO_SESSION_KEY)
  })

  for (const { section, label, note } of ENTRIES) {
    test(`${label} is listed as coming soon, with no Cloud claim`, async ({ page }) => {
      await page.goto(section, { waitUntil: "networkidle" })
      const entry = page.locator('span[aria-disabled="true"]', { hasText: new RegExp(`^${label}`) })
      await expect(entry).toHaveAttribute("title", note)
      await expect(entry).not.toContainText("Cloud")
      await expect(page.getByText("Available on Supatype Cloud")).toHaveCount(0)
    })
  }
})
