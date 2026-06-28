import { defineConfig } from "vitest/config"

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // Spec for src/engine/* (platform, cache, verify, resolve, download) — enable when Phase 0.5 modules land.
      "tests/engine-distribution.test.ts",
    ],
  },
})
