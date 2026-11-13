import { describe, expect, it } from "vitest"
import { isAuthSettingsView } from "../src/hooks/useCloudAuthSettings.js"

/**
 * The control plane's `GET /projects/:ref/environments/:env/auth` answer is read through a guard,
 * not a cast: a body of another shape is refused, never half-rendered.
 */

const FIELD = { value: "https://app.example.com", source: "code", codeValue: "https://app.example.com", differsFromCode: false, updatedAt: "2026-11-13T10:00:00Z", updatedBy: "nic@example.com" }

const VIEW = {
  environment: "production",
  version: 4,
  appliedVersion: 3,
  appliedAt: "2026-11-13T09:00:00Z",
  fields: { "auth.siteUrl": FIELD, "auth.redirectUrls": { ...FIELD, value: ["https://a.test/*"], codeValue: null, source: "studio" } },
  secrets: { "providers.github.secret": { set: true, fingerprint: "a1f9", source: "studio", updatedAt: null, updatedBy: null } },
  callbacks: { github: "https://api.example.test/auth/v1/callback" },
  platformRedirectUrls: ["https://studio.example.test/*"],
  platformSender: true,
  mailHourlyCap: 20,
}

describe("isAuthSettingsView", () => {
  it("accepts the contract shape", () => {
    expect(isAuthSettingsView(VIEW)).toBe(true)
  })

  it("accepts a null applied version and a null cap", () => {
    expect(isAuthSettingsView({ ...VIEW, appliedVersion: null, appliedAt: null, mailHourlyCap: null })).toBe(true)
  })

  it("refuses a body that is not an object", () => {
    expect(isAuthSettingsView(null)).toBe(false)
    expect(isAuthSettingsView("ok")).toBe(false)
  })

  it("refuses a field whose source is not one the contract names", () => {
    expect(isAuthSettingsView({ ...VIEW, fields: { "auth.siteUrl": { ...FIELD, source: "env" } } })).toBe(false)
  })

  it("refuses a field with no differsFromCode flag", () => {
    const { differsFromCode: _omitted, ...rest } = FIELD
    expect(isAuthSettingsView({ ...VIEW, fields: { "auth.siteUrl": rest } })).toBe(false)
  })

  it("refuses secrets that are not records of set and fingerprint", () => {
    expect(isAuthSettingsView({ ...VIEW, secrets: { "providers.github.secret": { set: "yes" } } })).toBe(false)
  })

  it("refuses a missing version, callbacks or platform sender", () => {
    expect(isAuthSettingsView({ ...VIEW, version: "4" })).toBe(false)
    expect(isAuthSettingsView({ ...VIEW, callbacks: ["x"] })).toBe(false)
    expect(isAuthSettingsView({ ...VIEW, platformSender: undefined })).toBe(false)
  })
})
