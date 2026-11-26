import { describe, expect, it } from "vitest"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/** `build.publicEnv`: the public values a static site reads, one string for every environment or a map of environment to string. */
const config = (build: unknown, server: Record<string, unknown> = {}): SupatypeProjectConfig =>
  validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode: "standalone" as const, ...server },
      app: { mode: "none" as const },
      database: { provider: "docker" as const },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
      build,
    },
    "supatype.config.ts",
  )

describe("build.publicEnv", () => {
  it("takes a string for every environment and a map of environment to string", () => {
    const cfg = config({ publicEnv: { MAPS_KEY: "m", STRIPE_PK: { production: "pk_live_1", staging: "pk_test_1" } } })
    expect(cfg.build?.publicEnv).toEqual({ MAPS_KEY: "m", STRIPE_PK: { production: "pk_live_1", staging: "pk_test_1" } })
  })

  it("is optional", () => {
    expect(() => config({})).not.toThrow()
  })

  it("must be an object", () => {
    expect(() => config({ publicEnv: ["A"] })).toThrow(/build\.publicEnv must be an object/)
    expect(() => config({ publicEnv: "A=1" })).toThrow(/build\.publicEnv must be an object/)
  })

  it("refuses a value that is neither a string nor a map of strings", () => {
    expect(() => config({ publicEnv: { A: 1 } })).toThrow(/build\.publicEnv\.A/)
    expect(() => config({ publicEnv: { A: { production: 1 } } })).toThrow(/build\.publicEnv\.A\.production/)
    expect(() => config({ publicEnv: { A: null } })).toThrow(/build\.publicEnv\.A/)
  })

  it("refuses a name that is not allowed, naming it", () => {
    expect(() => config({ publicEnv: { "bad-name": "x" } })).toThrow(/build\.publicEnv\.bad-name/)
    expect(() => config({ publicEnv: { VITE_X: "x" } })).toThrow(/VITE_X/)
  })

  it("refuses a value that looks secret, without printing it", () => {
    let message = ""
    try {
      config({ publicEnv: { STRIPE: "sk_live_51Habcdefghijkl" } })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/build\.publicEnv\.STRIPE/)
    expect(message).toMatch(/secret key/)
    expect(message).not.toContain("51Habcdefghijkl")
  })

  it("refuses a secret in one environment's entry", () => {
    expect(() => config({ publicEnv: { K: { production: "pk_live_1", staging: "-----BEGIN PRIVATE KEY-----" } } })).toThrow(/build\.publicEnv\.K/)
  })

  it("refuses an environment name the control plane would not accept", () => {
    expect(() => config({ publicEnv: { K: { "Not Valid": "x" } } })).toThrow(/environment/)
  })

  it("is refused when the server publishes no public env, since nothing would serve it", () => {
    expect(() => config({ publicEnv: { A: "1" } }, { public_env: false })).toThrow(/server\.public_env/)
    expect(() => config({}, { public_env: false })).not.toThrow()
  })
})
