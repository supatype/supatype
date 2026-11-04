import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Some tests load the service's modules afresh for each case (vi.resetModules, then import), and
    // some start an HTTP server and a database pool and close them after. Each takes well under a
    // second alone, but `turbo run test` runs every package's suite at once, and under that load the
    // 5s test and 10s hook defaults ran out (the STORAGE_QUOTA case and caller-rules' teardown).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
