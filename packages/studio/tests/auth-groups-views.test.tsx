// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { PlatformCtx, type PlatformContext } from "../src/hooks/usePlatform.js"
import { isAuthSettingsView } from "../src/hooks/useCloudAuthSettings.js"
import { AttackProtectionView } from "../src/views/auth/AttackProtectionView.js"
import { AuthHooksView } from "../src/views/auth/AuthHooksView.js"
import { usePendingChoice, type CloudAuthEditor, type PendingChoiceSpec } from "../src/views/auth/CloudAuthParts.js"
import type { AuthSettingsEdit, AuthSettingsView } from "../src/hooks/useCloudAuthSettings.js"
import { ConfigurationView } from "../src/views/auth/ConfigurationView.js"
import { groupRequiredSecretKeys, SMS_PROVIDERS } from "@supatype/types"
import { ANONYMOUS_SPECS, CAPTCHA_SPECS, MFA_SPECS, PASSWORD_SPECS, PHONE_COMMON_SPECS, RATE_LIMIT_SPECS, SAML_SPECS, SESSION_SPECS, smsProviderFields } from "../src/views/auth/authGroupSpecs.js"
import { testClient } from "./support.js"

/**
 * The auth settings beyond sign-in basics (hooks, attack protection, sessions, MFA, phone, SAML):
 * editable per environment on Cloud through the control plane, read-only on self-host.
 */

const CLOUD: PlatformContext = { platformUrl: "https://api.example.test/api/v1", projectRef: "abc123", environment: "production" }
const SELF_HOST: PlatformContext = { platformUrl: undefined, projectRef: undefined }
const CLIENT = testClient({ url: "https://api.example.test/api/v1/projects/abc123/proxy", token: "token" })
const ROUTE = "https://api.example.test/api/v1/projects/abc123/environments/production/auth"
const VERIFY = "https://api.example.test/api/v1/projects/abc123/studio/auth/verify"

type Value = string | number | boolean | string[] | null

const field = (value: Value, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  value,
  source: "default",
  codeValue: null,
  differsFromCode: false,
  updatedAt: null,
  updatedBy: null,
  ...over,
})

const unset = { set: false, fingerprint: null, source: null, updatedAt: null, updatedBy: null }

function viewBody(fields: Record<string, unknown>, secrets: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environment: "production",
    version: 5,
    appliedVersion: 5,
    appliedAt: "2026-11-13T09:00:00Z",
    fields,
    secrets,
    callbacks: {},
    platformRedirectUrls: [],
    platformSender: true,
    mailHourlyCap: null,
  }
}

interface Sent { method: string; url: string; body: unknown }
let root: Root | null = null
let container: HTMLElement
let sent: Sent[] = []

const role = (administer: boolean): Response => Response.json({ sub: "u1", role: administer ? "owner" : "viewer", permissions: { administer } })

interface Options { body?: Record<string, unknown>; administer?: boolean; put?: () => Response }

async function render(platform: PlatformContext, page: React.ReactElement, options: Options = {}): Promise<void> {
  sent = []
  const body = options.body ?? viewBody({})
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    sent.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
    if (url === VERIFY) return role(options.administer ?? true)
    if (url === ROUTE) return method === "PUT" && options.put !== undefined ? options.put() : Response.json(body)
    return Response.json({ external: {} })
  })
  container = document.createElement("div")
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <PlatformCtx.Provider value={platform}>
        <AdminClientContext.Provider value={CLIENT}>{page}</AdminClientContext.Provider>
      </PlatformCtx.Provider>,
    ),
  )
  for (let i = 0; i < 6; i++) await act(async () => {})
}

const button = (label: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label || b.getAttribute("aria-label") === label)

const byLabel = (label: string): Element | null => container.querySelector(`[aria-label="${label}"]`)

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    set?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const puts = (): Sent[] => sent.filter((s) => s.method === "PUT")

beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.unstubAllGlobals()
})

describe("the Cloud Attack Protection page", () => {
  it("is a real page with CAPTCHA, passwords and rate limits, not a coming-soon placeholder", async () => {
    await render(CLOUD, <AttackProtectionView />, { body: viewBody({ "auth.password.leakedPasswordCheck": field(false), "auth.rateLimits.otp": field(30) }) })
    const text = container.textContent ?? ""
    expect(text).not.toContain("Coming soon")
    for (const title of ["CAPTCHA", "Passwords", "Rate limits"]) expect(text).toContain(title)
    expect(byLabel("Leaked password check")).not.toBeNull()
    expect(byLabel("OTP requests per 5 minutes")).not.toBeNull()
  })

  it("saves the CAPTCHA switch as a set body", async () => {
    await render(CLOUD, <AttackProtectionView />, { body: viewBody({ "auth.captcha.enabled": field(false) }) })
    await act(async () => { (byLabel("CAPTCHA enabled") as HTMLButtonElement).click() })
    expect(puts()[0]?.body).toEqual({ set: { "auth.captcha.enabled": true } })
  })

  it("shows the control plane's refusal when CAPTCHA is enabled without its secret", async () => {
    const refuse = (): Response => Response.json({ message: "captcha.secret is required while CAPTCHA is enabled" }, { status: 400 })
    await render(CLOUD, <AttackProtectionView />, { body: viewBody({ "auth.captcha.enabled": field(false) }), put: refuse })
    await act(async () => { (byLabel("CAPTCHA enabled") as HTMLButtonElement).click() })
    expect(container.textContent).toContain("captcha.secret is required while CAPTCHA is enabled")
  })

  it("sets the CAPTCHA secret write-only", async () => {
    await render(CLOUD, <AttackProtectionView />, { body: viewBody({ "auth.captcha.enabled": field(false) }, { "captcha.secret": unset }) })
    expect(container.textContent).toContain("not set")
    await type(byLabel("CAPTCHA secret") as HTMLInputElement, "hcaptcha-key")
    await act(async () => { button("Set CAPTCHA secret")!.click() })
    expect(puts()[0]?.body).toEqual({ secrets: { "captcha.secret": "hcaptcha-key" } })
    expect((byLabel("CAPTCHA secret") as HTMLInputElement).value).toBe("")
    expect(container.innerHTML).not.toContain("hcaptcha-key")
  })

  it("saves required characters as a list in the order of the options", async () => {
    await render(CLOUD, <AttackProtectionView />, { body: viewBody({ "auth.password.requiredCharacters": field(["upper"]) }) })
    await act(async () => { (byLabel("Required characters lower") as HTMLInputElement).click() })
    expect(puts()[0]?.body).toEqual({ set: { "auth.password.requiredCharacters": ["lower", "upper"] } })
  })

  it("saves a rate limit as a number and says it applies after a restart", async () => {
    await render(CLOUD, <AttackProtectionView />, { body: viewBody({ "auth.rateLimits.otp": field(30) }) })
    expect(container.textContent).toContain("take effect after this environment's auth server restarts")
    await type(byLabel("OTP requests per 5 minutes") as HTMLInputElement, "60")
    await act(async () => { button("Save OTP requests per 5 minutes")!.click() })
    expect(puts()[0]?.body).toEqual({ set: { "auth.rateLimits.otp": 60 } })
  })

  it("gives a viewer the values and no inputs", async () => {
    await render(CLOUD, <AttackProtectionView />, { administer: false, body: viewBody({ "auth.rateLimits.otp": field(30) }) })
    expect(container.textContent).toContain("30")
    expect(container.querySelector("input, textarea, select, [role=switch]")).toBeNull()
  })

  it("reads a setting an older control plane left out as not available, with no editor", async () => {
    await render(CLOUD, <AttackProtectionView />, { body: viewBody({ "auth.captcha.enabled": field(false) }) })
    expect(container.textContent).toContain("Not available")
    expect(byLabel("OTP requests per 5 minutes")).toBeNull()
    expect(byLabel("CAPTCHA enabled")).not.toBeNull()
  })
})

describe("the Cloud Auth Hooks page", () => {
  it("has one section per hook and explains the URI and the secret", async () => {
    await render(CLOUD, <AuthHooksView />)
    const text = container.textContent ?? ""
    expect(text).not.toContain("Coming soon")
    for (const title of ["Custom access token", "Before user created", "After user created", "MFA verification attempt", "Password verification attempt", "Send email", "Send SMS"]) {
      expect(text).toContain(title)
    }
    expect(text).toContain("pg-functions://postgres/<schema>/<function>")
    expect(text).toContain("v1,whsec_")
  })

  it("saves a hook's URI and switch", async () => {
    await render(CLOUD, <AuthHooksView />, { body: viewBody({ "auth.hooks.sendEmail.uri": field("https://old.example.com"), "auth.hooks.sendEmail.enabled": field(true) }) })
    await type(byLabel("Send email hook URI") as HTMLInputElement, "https://fn.example.com/send")
    await act(async () => { button("Save Send email hook URI")!.click() })
    expect(puts()[0]?.body).toEqual({ set: { "auth.hooks.sendEmail.uri": "https://fn.example.com/send" } })
    await act(async () => { (byLabel("Send email hook enabled") as HTMLButtonElement).click() })
    expect(puts()[1]?.body).toEqual({ set: { "auth.hooks.sendEmail.enabled": false } })
  })

  it("shows a hook nothing switches as on only once its URI is set, as the server reads it", async () => {
    // Every unset hook showed as on, while the server ran none of them.
    await render(CLOUD, <AuthHooksView />, { body: viewBody({ "auth.hooks.sendEmail.uri": field("https://fn.example.com"), "auth.hooks.sendEmail.enabled": field(null), "auth.hooks.sendSms.uri": field(null), "auth.hooks.sendSms.enabled": field(null) }) })
    expect((byLabel("Send email hook enabled") as HTMLButtonElement).getAttribute("aria-checked")).toBe("true")
    expect((byLabel("Send SMS hook enabled") as HTMLButtonElement).getAttribute("aria-checked")).toBe("false")
  })

  it("sets a hook's signing secret under its own key", async () => {
    await render(CLOUD, <AuthHooksView />, { body: viewBody({ "auth.hooks.sendSms.uri": field("https://x.example.com") }, { "hooks.sendSms.secrets": unset }) })
    await type(byLabel("Send SMS hook secret") as HTMLInputElement, "v1,whsec_abc")
    await act(async () => { button("Set Send SMS hook secret")!.click() })
    expect(puts()[0]?.body).toEqual({ secrets: { "hooks.sendSms.secrets": "v1,whsec_abc" } })
  })
})

describe("the Cloud Configuration page, new sections", () => {
  it("reads a platform-held secret source from the control plane", () => {
    const secrets = { "sso.saml.private_key": { set: true, fingerprint: "ab12", source: "platform", updatedAt: null, updatedBy: null } }
    expect(isAuthSettingsView(viewBody({}, secrets))).toBe(true)
  })

  it("shows the SAML signing key as managed by Supatype, never as a value or an input", async () => {
    const secrets = { "sso.saml.private_key": { set: true, fingerprint: "ab12", source: "platform", updatedAt: null, updatedBy: null } }
    await render(CLOUD, <ConfigurationView />, { body: viewBody({ "auth.sso.saml.enabled": field(true) }, secrets) })
    expect(container.textContent).toContain("SAML signing key")
    expect(container.textContent).toContain("Managed by Supatype")
    expect(container.textContent).not.toContain("ab12")
    expect(container.querySelector('input[type="password"]')).toBeNull()
  })

  it("saves a session limit in seconds", async () => {
    await render(CLOUD, <ConfigurationView />, { body: viewBody({ "auth.sessions.timebox": field(3600) }) })
    await type(byLabel("Session time limit (seconds)") as HTMLInputElement, "7200")
    await act(async () => { button("Save Session time limit (seconds)")!.click() })
    expect(puts()[0]?.body).toEqual({ set: { "auth.sessions.timebox": 7200 } })
  })

  it("shows a setting that is on by default as on while nothing sets it", async () => {
    await render(CLOUD, <ConfigurationView />, { body: viewBody({ "auth.security.refreshTokenRotation": field(null) }) })
    expect((byLabel("Refresh token rotation") as HTMLButtonElement).getAttribute("aria-checked")).toBe("true")
  })

  it("flags a Studio value masking config on a new row and resets it by path", async () => {
    const masked = field(120, { source: "studio", codeValue: 300, differsFromCode: true })
    await render(CLOUD, <ConfigurationView />, { body: viewBody({ "auth.sessions.inactivityTimeout": masked }) })
    expect(container.textContent).toContain("Differs from config")
    await act(async () => { button("Reset Inactivity timeout (seconds)")!.click() })
    expect(puts()[0]?.body).toEqual({ reset: ["auth.sessions.inactivityTimeout"] })
  })

  it("shows only the chosen SMS provider's fields and secret", async () => {
    await render(CLOUD, <ConfigurationView />, { body: viewBody({ "auth.phone.provider": field("vonage"), "auth.phone.vonage.apiKey": field("k"), "auth.phone.vonage.from": field("Acme") }, { "phone.vonage.apiSecret": unset }) })
    expect(byLabel("Vonage API key")).not.toBeNull()
    expect(byLabel("Vonage API secret secret")).not.toBeNull()
    expect(byLabel("Twilio account SID")).toBeNull()
    expect(byLabel("MessageBird originator")).toBeNull()
  })

  it("sets the chosen provider's secret write-only", async () => {
    await render(CLOUD, <ConfigurationView />, { body: viewBody({ "auth.phone.provider": field("twilio") }, { "phone.twilio.authToken": unset }) })
    await type(byLabel("Twilio auth token secret") as HTMLInputElement, "tw-token")
    await act(async () => { button("Set Twilio auth token secret")!.click() })
    expect(puts()[0]?.body).toEqual({ secrets: { "phone.twilio.authToken": "tw-token" } })
  })

  it("shows the control plane's refusal of the combined provider and secret save", async () => {
    const refuse = (): Response => Response.json({ message: "phone.twilio.authToken is required for the twilio provider" }, { status: 400 })
    await render(CLOUD, <ConfigurationView />, { body: viewBody({ "auth.phone.provider": field(null) }, { "phone.twilio.authToken": unset }), put: refuse })
    await act(async () => {
      const select = byLabel("SMS provider") as HTMLSelectElement
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
      set?.call(select, "twilio")
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await type(byLabel("Twilio auth token secret") as HTMLInputElement, "x")
    await act(async () => { button("Set Twilio auth token secret")!.click() })
    expect(container.textContent).toContain("phone.twilio.authToken is required for the twilio provider")
  })

  it("resets a Studio value that has no pushed counterpart", async () => {
    const studioOnly = field(7200, { source: "studio", codeValue: null, differsFromCode: false })
    await render(CLOUD, <ConfigurationView />, { body: viewBody({ "auth.sessions.timebox": studioOnly }) })
    expect(container.textContent).not.toContain("Differs from config")
    await act(async () => { button("Reset Session time limit (seconds)")!.click() })
    expect(puts()[0]?.body).toEqual({ reset: ["auth.sessions.timebox"] })
  })

  it("offers no Reset on a row nothing in Studio set", async () => {
    await render(CLOUD, <ConfigurationView />, { body: viewBody({ "auth.sessions.timebox": field(null) }) })
    expect(button("Reset Session time limit (seconds)")).toBeUndefined()
  })

  it("reveals a chosen SMS provider's fields and secret without saving, then saves both together", async () => {
    await render(CLOUD, <ConfigurationView />, { body: viewBody({ "auth.phone.provider": field(null), "auth.phone.twilio.accountSid": field(null) }, { "phone.twilio.authToken": unset }) })
    expect(byLabel("Twilio auth token secret")).toBeNull()
    await act(async () => {
      const select = byLabel("SMS provider") as HTMLSelectElement
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
      set?.call(select, "twilio")
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(puts()).toHaveLength(0)
    expect(byLabel("Twilio account SID")).not.toBeNull()
    await type(byLabel("Twilio auth token secret") as HTMLInputElement, "tw-token")
    await act(async () => { button("Set Twilio auth token secret")!.click() })
    expect(puts()).toHaveLength(1)
    expect(puts()[0]?.body).toEqual({ set: { "auth.phone.provider": "twilio" }, secrets: { "phone.twilio.authToken": "tw-token" } })
  })

  it("reveals a chosen SES provider's two key rows without saving, then saves provider and both keys together", async () => {
    const unsetKeys = { "email.ses_access_key_id": unset, "email.ses_secret_access_key": unset }
    await render(CLOUD, <ConfigurationView />, { body: viewBody({ "email.provider": field(null) }, unsetKeys) })
    expect(byLabel("SES access key ID secret")).toBeNull()
    await act(async () => {
      const select = byLabel("Mail provider") as HTMLSelectElement
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
      set?.call(select, "ses")
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(puts()).toHaveLength(0)
    await type(byLabel("SES access key ID secret") as HTMLInputElement, "AKIA1")
    await act(async () => { button("Set SES access key ID secret")!.click() })
    expect(puts()).toHaveLength(0)
    await type(byLabel("SES secret access key secret") as HTMLInputElement, "s3cret")
    await act(async () => { button("Set SES secret access key secret")!.click() })
    expect(puts()).toHaveLength(1)
    expect(puts()[0]?.body).toEqual({
      set: { "email.provider": "ses" },
      secrets: { "email.ses_access_key_id": "AKIA1", "email.ses_secret_access_key": "s3cret" },
    })
  })

  it("never sends a removal of a held key along with a pending provider choice", async () => {
    const held = { set: true, fingerprint: "ab12", source: "studio", updatedAt: null, updatedBy: null }
    const secrets = { "email.ses_access_key_id": held, "email.ses_secret_access_key": unset }
    await render(CLOUD, <ConfigurationView />, { body: viewBody({ "email.provider": field(null) }, secrets) })
    await act(async () => {
      const select = byLabel("Mail provider") as HTMLSelectElement
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
      set?.call(select, "ses")
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await type(byLabel("SES secret access key secret") as HTMLInputElement, "s3cret")
    await act(async () => { button("Set SES secret access key secret")!.click() })
    expect(puts()).toHaveLength(1)
    expect(puts()[0]?.body).toEqual({ set: { "email.provider": "ses" }, secrets: { "email.ses_secret_access_key": "s3cret" } })
  })

  it("saves SES straight away when both keys are already held", async () => {
    const held = { set: true, fingerprint: "ab12", source: "studio", updatedAt: null, updatedBy: null }
    await render(CLOUD, <ConfigurationView />, { body: viewBody({ "email.provider": field(null) }, { "email.ses_access_key_id": held, "email.ses_secret_access_key": held }) })
    await act(async () => {
      const select = byLabel("Mail provider") as HTMLSelectElement
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
      set?.call(select, "ses")
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(puts()[0]?.body).toEqual({ set: { "email.provider": "ses" } })
  })

  it("reads settings an older control plane left out as not available", async () => {
    await render(CLOUD, <ConfigurationView />, { body: viewBody({}) })
    expect(container.textContent).toContain("Not available")
    expect(byLabel("Session time limit (seconds)")).toBeNull()
    expect(byLabel("Anonymous sign-in")).toBeNull()
  })
})

describe("self-host", () => {
  it("shows Attack Protection read-only, naming the config keys and never calling the control plane", async () => {
    await render(SELF_HOST, <AttackProtectionView />)
    expect(sent.some((s) => s.url.includes("/environments/"))).toBe(false)
    expect(container.querySelector("input, textarea, select, [role=switch]")).toBeNull()
    expect(container.textContent).toContain("Set in supatype.config.ts")
    expect(container.textContent).toContain("auth.captcha.enabled")
    expect(container.textContent).toContain("auth.rateLimits.otp")
    expect(container.textContent).not.toContain("auth.captcha.enabled, or")
    expect(container.textContent).not.toContain("auth server env")
  })

  it("shows Auth Hooks read-only with each hook's config key", async () => {
    await render(SELF_HOST, <AuthHooksView />)
    expect(container.querySelector("input, textarea, select, [role=switch]")).toBeNull()
    expect(container.textContent).toContain("auth.hooks.customAccessToken.uri")
    expect(container.textContent).toContain("auth.hooks.sendSms.enabled")
  })

  it("lists sessions, MFA and SAML options on Configuration with the config key each", async () => {
    await render(SELF_HOST, <ConfigurationView />)
    const text = container.textContent ?? ""
    expect(text).toContain("auth.sessions.timebox")
    expect(text).toContain("auth.mfa.totp.enroll")
    expect(text).toContain("auth.sso.saml.relayStateValidity")
    expect(container.querySelector("input, textarea")).toBeNull()
  })
})

describe("defaults on rows nothing sets", () => {
  const ALL_FIELDS = [...CAPTCHA_SPECS, ...PASSWORD_SPECS, ...RATE_LIMIT_SPECS, ...SESSION_SPECS, ...MFA_SPECS, ...ANONYMOUS_SPECS, ...PHONE_COMMON_SPECS, ...SAML_SPECS]
  const unsetBody = (): Record<string, unknown> => viewBody(Object.fromEntries(ALL_FIELDS.map((s) => [s.path, field(null)])))

  const rowOf = (label: string): HTMLTableRowElement => {
    const row = Array.from(container.querySelectorAll("tr")).find((tr) => tr.querySelector("td")?.textContent === label)
    if (row === undefined) throw new Error(`no row labelled ${label}`)
    return row
  }
  const sourceOf = (label: string): string => rowOf(label).querySelectorAll("td")[2]?.textContent ?? ""

  it("shows the effective default as the placeholder and in the source of every Attack Protection row", async () => {
    await render(CLOUD, <AttackProtectionView />, { body: unsetBody() })
    expect((byLabel("OTP requests per 5 minutes") as HTMLInputElement).placeholder).toBe("30")
    expect(sourceOf("OTP requests per 5 minutes")).toBe("default: 30")
    expect((byLabel("Token refreshes per 5 minutes") as HTMLInputElement).placeholder).toBe("150")
    expect((byLabel("MFA challenges and verifies per minute") as HTMLInputElement).placeholder).toBe("15")
    // The fallback sent is 0 and the server raises it to 6, so 6 is what applies.
    expect((byLabel("Minimum password length") as HTMLInputElement).placeholder).toBe("6")
    expect(sourceOf("Minimum password length")).toBe("default: 6")
    expect(sourceOf("CAPTCHA enabled")).toBe("default: off")
    expect(sourceOf("Leaked password check")).toBe("default: off")
    expect(sourceOf("CAPTCHA provider")).toBe("default: hcaptcha")
    expect(sourceOf("Required characters")).toBe("default: none")
    for (const spec of [...CAPTCHA_SPECS, ...PASSWORD_SPECS, ...RATE_LIMIT_SPECS]) expect(sourceOf(spec.label)).toMatch(/^default: /)
  })

  it("shows the effective default on every Configuration row that has one", async () => {
    await render(CLOUD, <ConfigurationView />, { body: unsetBody() })
    expect((byLabel("Assertion rate limit per 5 minutes") as HTMLInputElement).placeholder).toBe("15")
    expect(sourceOf("Relay state validity (seconds)")).toBe("default: 120")
    expect(sourceOf("Code length (digits)")).toBe("default: 6")
    expect(sourceOf("Code lifetime (seconds)")).toBe("default: 60")
    expect(sourceOf("Minimum seconds between codes")).toBe("default: 60")
    expect(sourceOf("Session time limit (seconds)")).toBe("default: none")
    expect(sourceOf("Refresh token rotation")).toBe("default: on")
    expect(sourceOf("Authenticator app enrol")).toBe("default: on")
    expect(sourceOf("Maximum enrolled factors")).toBe("default: 10")
    for (const spec of [...SESSION_SPECS, ...MFA_SPECS, ...ANONYMOUS_SPECS, ...PHONE_COMMON_SPECS, ...SAML_SPECS]) expect(sourceOf(spec.label)).toMatch(/^default: /)
  })

  it("keeps the source a layer names once a layer sets the value", async () => {
    await render(CLOUD, <AttackProtectionView />, { body: viewBody({ "auth.rateLimits.otp": field(45, { source: "studio" }) }) })
    expect(sourceOf("OTP requests per 5 minutes")).toContain("Studio edit")
    expect(sourceOf("OTP requests per 5 minutes")).not.toContain("default")
  })

  it("shows the default to a role that can only read", async () => {
    await render(CLOUD, <AttackProtectionView />, { body: unsetBody(), administer: false })
    expect(rowOf("OTP requests per 5 minutes").querySelectorAll("td")[1]?.textContent).toContain("default: 30")
    expect(rowOf("OTP requests per 5 minutes").textContent).not.toContain("Not set")
  })

  it("labels each rate limit with the window the auth server counts it in", async () => {
    await render(CLOUD, <AttackProtectionView />, { body: unsetBody() })
    expect(byLabel("Anonymous sign-ins per hour")).not.toBeNull()
    expect(byLabel("MFA challenges and verifies per minute")).not.toBeNull()
    expect(byLabel("SMS sent per hour")).not.toBeNull()
    expect(byLabel("Anonymous sign-ins per 5 minutes")).toBeNull()
    expect(byLabel("MFA challenges and verifies per 5 minutes")).toBeNull()
  })

  it("shows the same defaults on the self-host read-only page", async () => {
    await render(SELF_HOST, <AttackProtectionView />)
    const text = container.textContent ?? ""
    expect(text).toContain("default: 30")
    expect(text).toContain("default: 150")
    expect(text).toContain("default: 6")
    expect(text).toContain("default: hcaptcha")
    expect(text).toContain("Set in supatype.config.ts")
  })
})

describe("a pending provider choice", () => {
  const KEYS = ["k.a", "k.b"]
  const SPEC: PendingChoiceSpec = { path: "choice", secretKeys: (choice) => (choice === "two" ? KEYS : []) }
  const held = { set: true, fingerprint: "ab12", source: "studio", updatedAt: null, updatedBy: null }

  /** The editor the hook wraps: key a is held, key b is not. Every edit it is finally given is recorded. */
  async function harness(): Promise<{ editor: () => CloudAuthEditor; saved: AuthSettingsEdit[] }> {
    const saved: AuthSettingsEdit[] = []
    const view = { ...viewBody({ choice: field(null) }, { "k.a": held, "k.b": unset }) } as unknown as AuthSettingsView
    const inner: CloudAuthEditor = { view, loading: false, error: null, canEdit: true, busy: false, save: async (edit) => { saved.push(edit); return true } }
    let current: CloudAuthEditor = inner
    function Probe(): null {
      current = usePendingChoice(inner, SPEC)
      return null
    }
    container = document.createElement("div")
    root = createRoot(container)
    await act(async () => { root!.render(<Probe />) })
    return { editor: () => current, saved }
  }

  it("never sends a removal of a held key together with the choice", async () => {
    const { editor, saved } = await harness()
    await act(async () => { await editor().save({ set: { choice: "two" } }) })
    await act(async () => { await editor().save({ secrets: { "k.a": null, "k.b": "typed" } }) })
    expect(saved.flatMap((edit) => Object.values(edit.secrets ?? {}))).not.toContain(null)
    expect(saved).toHaveLength(0)
  })

  it("sends the choice with both secrets once each is held or typed", async () => {
    const { editor, saved } = await harness()
    await act(async () => { await editor().save({ set: { choice: "two" } }) })
    await act(async () => { await editor().save({ secrets: { "k.b": "typed" } }) })
    expect(saved).toEqual([{ set: { choice: "two" }, secrets: { "k.b": "typed" } }])
  })
})

describe("the SMS provider fields", () => {
  it("name the same secret the shared settings table requires, for every provider", () => {
    for (const provider of SMS_PROVIDERS) {
      expect(groupRequiredSecretKeys({ auth: { phone: { provider } } })).toEqual([smsProviderFields(provider)?.secret.key])
    }
  })
})
