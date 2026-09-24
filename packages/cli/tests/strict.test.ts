/**
 * Strict mode, which decides whether a degraded path is survivable.
 *
 * The behaviour under test is the *difference* between the two modes, so each case asserts both
 * halves. A test that only checked the throw would pass against an implementation that threw
 * always, which would break every interactive fallback the CLI has on purpose.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { degraded, strict } from "../src/strict.js"

const KEY = "SUPATYPE_STRICT"
let original: string | undefined

beforeEach(() => {
  original = process.env[KEY]
  delete process.env[KEY]
})

afterEach(() => {
  if (original === undefined) delete process.env[KEY]
  else process.env[KEY] = original
  vi.restoreAllMocks()
})

describe("strict()", () => {
  it("is off when the variable is unset", () => {
    expect(strict()).toBe(false)
  })

  it("is on only for exactly \"1\"", () => {
    process.env[KEY] = "1"
    expect(strict()).toBe(true)
  })

  it("is off for other truthy-looking values", () => {
    // Deliberately narrow. A flag that accepts "true", "yes" and "on" is a flag whose meaning has
    // to be looked up, and this one turns warnings into build failures.
    for (const value of ["true", "yes", "on", "0", ""]) {
      process.env[KEY] = value
      expect(strict(), `value ${JSON.stringify(value)}`).toBe(false)
    }
  })
})

describe("degraded()", () => {
  it("warns and returns when strict is off, so an interactive run continues", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(() => degraded("Host engine unavailable", "CDN refused")).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain("Host engine unavailable")
  })

  it("throws when strict is on, so CI cannot pass over it", () => {
    process.env[KEY] = "1"
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(() => degraded("Host engine unavailable", "CDN refused")).toThrow(
      /Host engine unavailable/,
    )
    // Not warned as well: a run that fails should not also print the line that says it recovered.
    expect(warn).not.toHaveBeenCalled()
  })

  it("names the capability and the cause, because the assertion that fails names neither", () => {
    process.env[KEY] = "1"
    // The failure this exists to prevent read "expected validator refusal, got 200". The cause was
    // an engine download refused twenty lines earlier, and nothing in the failure said so.
    expect(() => degraded("Host engine unavailable", "no minisign public key configured")).toThrow(
      /no minisign public key configured/,
    )
  })

  it("says which flag made it fatal", () => {
    process.env[KEY] = "1"
    // Otherwise the reader's first move is to work out why a warning became an error.
    expect(() => degraded("Bucket unreachable", "ECONNREFUSED")).toThrow(/SUPATYPE_STRICT=1/)
  })
})
