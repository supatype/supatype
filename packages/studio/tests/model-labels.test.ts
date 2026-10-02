import { describe, expect, it } from "vitest"
import { pluralize, singularize } from "../src/lib/inflect.js"
import { normalizeAdminConfig } from "../src/lib/normalize-admin-config.js"

/**
 * Model labels for types named in either number (issue #94).
 *
 * Studio pluralized every label unconditionally, so a type already named in the plural got a second
 * suffix: "Childrens", "Placeses". These pin both directions, because a model named `Places` needs a
 * singular label too, or it is "Create Places".
 */

const CASES: ReadonlyArray<readonly [singular: string, plural: string]> = [
  ["Child", "Children"],
  ["Place", "Places"],
  ["Institution", "Institutions"],
  ["Child Education Experience", "Child Education Experiences"],
  ["Some multiple named item", "Some multiple named items"],
  ["Post", "Posts"],
  ["Status", "Statuses"],
  ["Category", "Categories"],
  ["Address", "Addresses"],
  ["House", "Houses"],
  ["Blog Person", "Blog People"],
  ["Page Cache", "Page Caches"],
  ["Site Data", "Site Data"],
]

describe("inflect", () => {
  it.each(CASES)("%s and %s inflect in both directions", (singular, plural) => {
    expect(pluralize(singular)).toBe(plural)
    expect(singularize(plural)).toBe(singular)
  })

  it.each(CASES)("%s and %s are left alone when already in the number asked for", (singular, plural) => {
    expect(pluralize(plural)).toBe(plural)
    expect(singularize(singular)).toBe(singular)
  })
})

function labelsFor(
  name: string,
  overrides: Record<string, unknown> = {},
): { label: string; labelPlural: string } {
  const config = normalizeAdminConfig({ models: [{ name, tableName: "t", fields: [], ...overrides }] })
  const model = config.models[0]
  if (model === undefined) throw new Error("no model normalized")
  return { label: model.label, labelPlural: model.labelPlural }
}

describe("normalizeAdminConfig model labels", () => {
  it.each([
    ["Children", "Child", "Children"],
    ["Institutions", "Institution", "Institutions"],
    ["Places", "Place", "Places"],
    ["ChildEducationExperiences", "Child Education Experience", "Child Education Experiences"],
    ["Post", "Post", "Posts"],
  ])("a type named %s is labelled %s / %s", (name, label, labelPlural) => {
    expect(labelsFor(name)).toEqual({ label, labelPlural })
  })
})

describe("normalizeAdminConfig label overrides", () => {
  const labelsWith = (overrides: Record<string, unknown>) => labelsFor("PlacesOfInterest", overrides)

  it("uses the project's own words for both labels when it set them", () => {
    expect(labelsWith({ label: "Place of Interest", labelPlural: "Places of Interest" })).toEqual({
      label: "Place of Interest",
      labelPlural: "Places of Interest",
    })
  })

  it("inflects the plural from a singular override when only that was set", () => {
    expect(labelsWith({ label: "Venue" })).toEqual({ label: "Venue", labelPlural: "Venues" })
  })

  it("derives both from the type name when the engine sends null or an empty string", () => {
    const derived = { label: "Places Of Interest", labelPlural: "Places Of Interests" }
    expect(labelsWith({ label: null, labelPlural: null })).toEqual(derived)
    expect(labelsWith({ label: "", labelPlural: "" })).toEqual(derived)
  })

  it("applies a global's singular override, and ignores an empty one", () => {
    const globalLabel = (label: unknown): string | undefined =>
      normalizeAdminConfig({ globals: [{ name: "SiteSettings", fields: [], label }] }).globals[0]?.label
    expect(globalLabel("Site Setup")).toBe("Site Setup")
    expect(globalLabel("")).toBe("Site Settings")
  })
})

describe("normalizeAdminConfig navigation labels", () => {
  it("names a navigation item by its model's label, not the raw type name the engine sends", () => {
    const config = normalizeAdminConfig({
      models: [{ name: "ChildEducationExperiences", tableName: "child_education_experiences", fields: [] }],
      globals: [{ name: "SiteSettings", tableName: "_global_site_settings", fields: [] }],
      navigation: [
        { group: "Content", items: [{ label: "ChildEducationExperiences", model: "child_education_experiences" }] },
        { group: "Settings", items: [{ label: "SiteSettings", global: "_global_site_settings" }] },
      ],
    })
    expect(config.navigation.map((group) => group.items.map((item) => item.label))).toEqual([
      ["Child Education Experiences"],
      ["Site Settings"],
    ])
  })
})
