import { describe, expect, it } from "vitest"
import { DEFAULT_STUDIO_ADMIN_ROLES, studioAdminRoles, withAdminRoles } from "../src/studio-admin-roles.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

const baseConfig: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
  versions: { engine: "0", server: "0", postgres: "0", deno: "0" },
}

describe("studioAdminRoles", () => {
  it("returns defaults when admin.roles is omitted", () => {
    expect(studioAdminRoles(baseConfig)).toEqual([...DEFAULT_STUDIO_ADMIN_ROLES])
  })

  it("uses admin.roles from config when set", () => {
    const roles = studioAdminRoles({ ...baseConfig, admin: { roles: ["custom_admin"] } })
    expect(roles).toEqual(["custom_admin"])
  })

  it("merges adminRoles into engine admin JSON", () => {
    const merged = withAdminRoles({ models: [] }, { ...baseConfig, admin: { roles: ["ops"] } })
    expect(merged).toEqual({ models: [], adminRoles: ["ops"] })
  })
})

describe("where the project says its models render", () => {
  const livePreview = {
    Post: { url: "https://example.com", urlPattern: "https://example.com/preview/{slug}" },
  }

  it("carries livePreview through to the admin config Studio reads", () => {
    // Studio cannot derive this from the schema: it is a fact about a deployment, not a shape. It
    // reaches Studio only if this merge puts it in the file.
    const merged = withAdminRoles({ models: [] }, { ...baseConfig, admin: { livePreview } })
    expect(merged["livePreview"]).toEqual(livePreview)
  })

  it("says nothing at all when the project has not configured it", () => {
    // Absent, not empty. Studio treats an absent entry as "this project has not said", which is
    // what makes it ask for the setting instead of offering a share link that opens nowhere. An
    // empty object would read as "configured, with no models".
    const merged = withAdminRoles({ models: [] }, baseConfig)
    expect(merged).not.toHaveProperty("livePreview")

    const empty = withAdminRoles({ models: [] }, { ...baseConfig, admin: { livePreview: {} } })
    expect(empty).not.toHaveProperty("livePreview")
  })

  it("keeps the roles alongside it, since one merge writes both", () => {
    const merged = withAdminRoles(
      { models: [] },
      { ...baseConfig, admin: { roles: ["ops"], livePreview } },
    )
    expect(merged).toEqual({ models: [], adminRoles: ["ops"], livePreview })
  })
})
