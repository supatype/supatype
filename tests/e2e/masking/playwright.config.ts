import { defineConfig } from "@playwright/test"

/**
 * The masking matrix: field masking and row visibility on every read and write channel, for every
 * caller, in one tier per run (MASKING_TIER). `tests/integration/scripts/masking-e2e.sh` brings
 * the stack up for each tier and runs this twice.
 *
 * No browser: every test is an HTTP or WebSocket client. Known open defects are marked
 * expected-fail per test (lib/defects.ts), so an unexpected pass fails the run.
 */
export default defineConfig({
  testDir: "./specs",
  globalSetup: "./global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // One stack, one database, and every spec reseeds it: nothing may run beside anything else.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  // A retry would let a flaky pass or fail hide; the train wants each verdict once.
  retries: 0,
  reporter: [["list"], ["json", { outputFile: process.env["MASKING_REPORT"] ?? "masking-report.json" }]],
})
