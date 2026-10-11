import { defineConfig } from "@playwright/test"

/**
 * The positioning checks: what the site promises about `supatype dev` in a project made by `init`
 * ("change a field once, nothing else to update; rename a field and the build fails instead of
 * production"). `tests/integration/scripts/positioning-e2e.sh` makes the project, starts dev with
 * the schema watcher on, and runs this. Both checks were open defects (V-N1, V-N2), fixed by H6 and H7.
 */
export default defineConfig({
  testDir: "./specs",
  timeout: 240_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: [["list"], ["json", { outputFile: process.env["POSITIONING_REPORT"] ?? "positioning-report.json" }]],
})
