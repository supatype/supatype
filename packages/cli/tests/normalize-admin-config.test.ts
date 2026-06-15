import { describe, expect, it } from "vitest"
import { normalizeAdminConfig } from "../../studio/src/lib/normalize-admin-config.js"

describe("normalizeAdminConfig", () => {
  it("maps global fields and Settings navigation items", () => {
    const config = normalizeAdminConfig({
      localization: { locales: ["en"], defaultLocale: "en" },
      navigation: [
        {
          group: "Content",
          items: [{ label: "Post", model: "posts" }],
        },
        {
          group: "Settings",
          items: [{ label: "Site Settings", global: "_global_site_settings" }],
        },
      ],
      models: [
        {
          name: "Post",
          tableName: "posts",
          fields: [{ name: "title", widget: "text", required: true }],
        },
      ],
      globals: [
        {
          name: "SiteSettings",
          tableName: "_global_site_settings",
          singleton: true,
          fields: [{ name: "site_name", widget: "text", required: true }],
        },
      ],
    })

    expect(config.globals).toHaveLength(1)
    expect(config.globals[0]?.tableName).toBe("_global_site_settings")
    expect(config.globals[0]?.apiPath).toBe("/rest/v1/_global_site_settings")
    expect(config.globals[0]?.fields).toHaveLength(1)
    expect(config.globals[0]?.fields[0]?.name).toBe("site_name")

    const settingsNav = config.navigation.find((g) => g.label === "Settings")
    expect(settingsNav?.items[0]).toMatchObject({
      type: "global",
      href: "/models/globals/SiteSettings",
      label: "Site Settings",
    })
  })
})
