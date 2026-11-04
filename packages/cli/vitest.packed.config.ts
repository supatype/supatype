import { defineConfig } from "vitest/config"

/** The packed-install tests: `npm pack` and `npm install` into temp apps, so they need the network. */
export default defineConfig({
  test: {
    include: ["tests/packed/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 600_000,
  },
})
