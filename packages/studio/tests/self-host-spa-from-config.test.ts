import { describe, expect, it } from "vitest"
import { isSiteStatus, settingsOf } from "../src/lib/self-host-static-site.js"

/**
 * The "Set in supatype.config.ts" label on the SPA fallback is shown only when the gateway says the
 * config set it (`spa_fallback_from_config`), not for a default.
 */
const STATUS = { mode: "static", spa_fallback: true, serving: true, file_count: 1, total_bytes: 1 }

describe("self-host site settings", () => {
  it("label the SPA fallback as the config's when the gateway says the config set it", () => {
    const status = { ...STATUS, spa_fallback_from_config: true }
    expect(isSiteStatus(status)).toBe(true)
    expect(settingsOf(status).fromConfig).toContain("spaFallback")
  })

  it("do not label it when the value is a default", () => {
    const status = { ...STATUS, spa_fallback_from_config: false }
    expect(isSiteStatus(status)).toBe(true)
    expect(settingsOf(status).fromConfig).not.toContain("spaFallback")
  })

  it("do not label it for a gateway that does not say", () => {
    expect(isSiteStatus(STATUS)).toBe(true)
    expect(settingsOf(STATUS).fromConfig).not.toContain("spaFallback")
  })

  it("still label the mode as the config's", () => {
    expect(settingsOf(STATUS).fromConfig).toContain("mode")
  })
})
