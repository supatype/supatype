import { describe, expect, it } from "vitest"
import { mapAuthUser } from "../src/views/AuthManagement.js"

/**
 * Fresh-test cosmetic: users made by `supatype admin create-user` showed an empty Providers column.
 * They sign in with an email and password but the auth server records no identity row for them, so
 * the list now names "email" for a user with an email and no identity.
 */

const CLI_USER = { id: "u1", email: "editor@fresh-cms.test", created_at: "2026-10-21T21:30:00Z", identities: [] }

describe("a user's providers", () => {
  it("name email for a password user the auth server holds no identity for", () => {
    expect(mapAuthUser(CLI_USER).providers.map((p) => p.provider)).toEqual(["email"])
  })

  it("keep the identities a user has", () => {
    const linked = { ...CLI_USER, identities: [{ provider: "github", id: "g1", created_at: "2026-10-21T21:31:00Z" }] }
    expect(mapAuthUser(linked).providers.map((p) => p.provider)).toEqual(["github"])
  })

  it("name none for a user with neither an email nor an identity", () => {
    expect(mapAuthUser({ id: "u2", phone: "+440000", identities: null }).providers).toEqual([])
  })
})
