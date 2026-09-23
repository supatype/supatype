import { defineConfig } from "vitest/config"

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    // Many tests here spawn the built CLI as a subprocess, so each one pays Node startup plus
    // the Ink and React import cost before it does any work. The 5s default leaves almost no
    // headroom, and CI runs `turbo run test`, which runs every package concurrently: the same
    // tests that take 1.2s alone take over 5s under that contention and fail as timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // Spec for src/engine/* (platform, cache, verify, resolve, download), enable when Phase 0.5 modules land.
      "tests/engine-distribution.test.ts",
    ],
  },
})
