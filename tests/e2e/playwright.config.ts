import { defineConfig, devices } from "@playwright/test"

/**
 * Browser end-to-end tests.
 *
 * These drive a running stack rather than starting one: `auth-flows-e2e.sh` and
 * friends already know how to bring compose up, and duplicating that in a
 * `webServer` block would give two ways to start the same thing that can drift.
 * Point `E2E_BASE_URL` at a stack and run.
 *
 * Chromium only. A second engine doubles the browser download and the CI minutes,
 * and nothing here is testing browser differences: it is testing that the UI is
 * wired to a server.
 */
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.SUPATYPE_KONG_PORT ?? "18473"}`

export default defineConfig({
  testDir: "./specs",
  // A UI served through Kong on a cold container is slower than a local dev
  // server, and a flaky timeout reads as a broken feature.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Serially: these share one stack and one database, so a test that signs up a
  // user must not race another that counts them.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    // On failure, the two things that actually explain a UI test.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
