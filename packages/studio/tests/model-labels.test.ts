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

describe("normalizeAdminConfig model labels", () => {
  function labelsFor(name: string): { label: string; labelPlural: string } {
    const config = normalizeAdminConfig({ models: [{ name, tableName: "t", fields: [] }] })
    const model = config.models[0]
    if (model === undefined) throw new Error("no model normalized")
    return { label: model.label, labelPlural: model.labelPlural }
  }

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
