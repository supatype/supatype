import { describe, expect, it } from "vitest"
import { getPageBreadcrumbs, getPageTitle } from "../src/components/Sidebar.js"
import { testConfig } from "./support.js"

const CONFIG = testConfig()

describe("page titles for rail entries", () => {
  it.each([
    ["/webhooks", "Webhooks"],
    ["/jobs", "Scheduled Jobs"],
    ["/ai/usage", "Intelligence"],
    ["/commerce", "Commerce"],
    ["/analytics", "Analytics"],
    ["/branching", "Branching"],
    ["/integrations", "Integrations"],
  ])("names %s after its rail entry, not the Studio fallback", (path, label) => {
    expect(getPageTitle(path, CONFIG)).toBe(label)
    expect(getPageBreadcrumbs(path, CONFIG)).toEqual([label])
  })

  it("still says Studio for a path no rail entry owns", () => {
    expect(getPageTitle("/nowhere", CONFIG)).toBe("Studio")
    expect(getPageBreadcrumbs("/nowhere", CONFIG)).toEqual(["Studio"])
  })
})
