import { describe, expect, it } from "vitest"
import { getPageBreadcrumbs, getPageTitle } from "../src/components/Sidebar.js"
import type { SidebarSection } from "../src/types.js"
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

describe("page titles for a host's own pages", () => {
  const HOST_SECTIONS: SidebarSection[] = [
    {
      title: "Cloud",
      mode: "developer",
      items: [
        { href: "/cloud/usage", label: "Usage" },
        { href: "/cloud/domains", label: "Custom Domains" },
        { href: "/cloud/settings", label: "Project Settings" },
      ],
    },
  ]

  it.each([
    ["/cloud/usage", "Usage"],
    ["/cloud/domains", "Custom Domains"],
    ["/cloud/settings", "Project Settings"],
  ])("names %s after the host's entry for it, not the Studio fallback", (path, label) => {
    expect(getPageTitle(path, CONFIG, HOST_SECTIONS)).toBe(label)
    expect(getPageBreadcrumbs(path, CONFIG, HOST_SECTIONS)).toEqual([label])
  })

  it("says Studio for a host page when the host lists no entry for it", () => {
    expect(getPageBreadcrumbs("/cloud/usage", CONFIG)).toEqual(["Studio"])
  })

  it("prefers a core page's own name over a host entry that shares its path", () => {
    const shadow: SidebarSection[] = [{ title: "Host", mode: "developer", items: [{ href: "/realtime", label: "Live" }] }]
    expect(getPageBreadcrumbs("/realtime", CONFIG, shadow)).toEqual(["Realtime"])
  })
})
