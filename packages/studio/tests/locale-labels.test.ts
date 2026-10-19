import { describe, expect, it } from "vitest"
import { normalizeAdminConfig } from "../src/lib/normalize-admin-config.js"

/**
 * The project's config lists locales by code. Every place Studio names a language (the top bar's
 * switcher, the publish panel's "Publish in English") reads the label made here, so the name is
 * decided once rather than by each view.
 */

const labels = (locales: string[]): string[] =>
  (normalizeAdminConfig({ localization: { locales, defaultLocale: "en" } }).locale?.locales ?? []).map((l) => l.label)

describe("locale labels", () => {
  it("names a locale by its language", () => {
    expect(labels(["en", "fr", "pt-BR"])).toEqual(["English", "French", "Brazilian Portuguese"])
  })

  it("keeps the code for a locale no language name exists for", () => {
    expect(labels(["xx-internal", "not_a_tag"])).toEqual(["xx-internal", "not_a_tag"])
  })
})
