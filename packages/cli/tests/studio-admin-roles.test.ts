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
