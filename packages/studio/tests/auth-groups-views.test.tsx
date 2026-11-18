// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { PlatformCtx, type PlatformContext } from "../src/hooks/usePlatform.js"
import { isAuthSettingsView } from "../src/hooks/useCloudAuthSettings.js"
import { AttackProtectionView } from "../src/views/auth/AttackProtectionView.js"
import { AuthHooksView } from "../src/views/auth/AuthHooksView.js"
import { ConfigurationView } from "../src/views/auth/ConfigurationView.js"
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

  it("shows the control plane's refusal when a provider is chosen without its secret", async () => {
    const refuse = (): Response => Response.json({ message: "phone.twilio.authToken is required for the twilio provider" }, { status: 400 })
    await render(CLOUD, <ConfigurationView />, { body: viewBody({ "auth.phone.provider": field(null) }), put: refuse })
    await act(async () => {
      const select = byLabel("SMS provider") as HTMLSelectElement
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
      set?.call(select, "twilio")
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(container.textContent).toContain("phone.twilio.authToken is required for the twilio provider")
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
