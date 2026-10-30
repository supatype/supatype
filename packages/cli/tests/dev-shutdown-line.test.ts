import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * Local test round 3: native Ctrl+C printed `[supatype] Shutting down…` and then
 * `[supatype] Shutting down...`. The shared handler (dev-shutdown.ts) says it before it runs the
 * work a provider registered, so the work says nothing of the kind itself.
 */
describe("native dev's shutdown work", () => {
  it("leaves announcing the shutdown to the shared handler", () => {
    const dev = readFileSync(new URL("../src/commands/dev.ts", import.meta.url), "utf8")
    const shared = readFileSync(new URL("../src/dev-shutdown.ts", import.meta.url), "utf8")
    expect(shared).toContain("[supatype] Shutting down…")
    expect(dev).not.toMatch(/Shutting down(\.\.\.|…)/)
  })
})
