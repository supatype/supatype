import { describe, expect, it } from "vitest"
import {
  AUTH_OWNED_KEYS,
  authSecretInUse,
  authSecretRefs,
  authSettingsToEnv,
  flattenAuthSettings,
  isAuthSecretKey,
  isAuthSettingPath,
  unflattenAuthSettings,
  validateAuthSettings,
  type AuthRenderContext,
  type AuthSettings,
} from "../src/auth-settings.js"
import {
  SAML_NEXT_PRIVATE_KEY_SECRET,
  SAML_PRIVATE_KEY_SECRET,
  groupRequiredSecretKeys,
  groupSecretFormatProblem,
  groupsSelfHostVars,
} from "../src/auth-settings-groups.js"

const ctx: AuthRenderContext = {
  callbackBaseUrl: "https://abc.supatype.io",
  siteUrl: "https://abc.supatype.io",
  platformRedirectUrls: [],
  secrets: {},
}

const GOOD_SECRET = "v1,whsec_abcdefghijklmnopqrstuvwxyz01234567"

describe("group settings rendering", () => {
  it("writes a default for every group variable when nothing is set, so a removed setting is unset", () => {
    const env = authSettingsToEnv({}, ctx)
    expect(env["SUPATYPE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED"]).toBe("true")
    expect(env["SUPATYPE_MFA_TOTP_ENROLL_ENABLED"]).toBe("true")
    expect(env["SUPATYPE_RATE_LIMIT_TOKEN_REFRESH"]).toBe("150")
    expect(env["SUPATYPE_HOOK_SEND_EMAIL_ENABLED"]).toBe("false")
    expect(env["SUPATYPE_HOOK_SEND_EMAIL_URI"]).toBe("")
    expect(env["SUPATYPE_SAML_ENABLED"]).toBe("false")
    for (const key of AUTH_OWNED_KEYS) expect(env[key]).not.toBeUndefined()
  })

  it("renders an unset session lifetime as a very long one, since a reloaded file cannot unset it", () => {
    expect(authSettingsToEnv({}, ctx)["SUPATYPE_SESSIONS_TIMEBOX"]).toBe("876000h")
    const env = authSettingsToEnv({ auth: { sessions: { timebox: 86400, inactivityTimeout: 3600 } } }, ctx)
    expect(env["SUPATYPE_SESSIONS_TIMEBOX"]).toBe("86400s")
    expect(env["SUPATYPE_SESSIONS_INACTIVITY_TIMEOUT"]).toBe("3600s")
  })

  it("turns a listed hook on, with its secret from the stored secrets", () => {
    const settings: AuthSettings = {
      auth: { hooks: { sendEmail: { uri: "https://fn.example.com/hook", secrets: "env(HOOK)" } } },
    }
    const env = authSettingsToEnv(settings, { ...ctx, secrets: { "hooks.sendEmail.secrets": GOOD_SECRET } })
    expect(env["SUPATYPE_HOOK_SEND_EMAIL_ENABLED"]).toBe("true")
    expect(env["SUPATYPE_HOOK_SEND_EMAIL_URI"]).toBe("https://fn.example.com/hook")
    expect(env["SUPATYPE_HOOK_SEND_EMAIL_SECRETS"]).toBe(GOOD_SECRET)
    expect(env["SUPATYPE_HOOK_SEND_SMS_ENABLED"]).toBe("false")
  })

  it("keeps a hook off when enabled is false, and does not render a secret nothing uses", () => {
    const settings: AuthSettings = { auth: { hooks: { sendSms: { enabled: false, uri: "https://fn.example.com/sms" } } } }
    const env = authSettingsToEnv(settings, { ...ctx, secrets: { "hooks.sendEmail.secrets": GOOD_SECRET } })
    expect(env["SUPATYPE_HOOK_SEND_SMS_ENABLED"]).toBe("false")
    expect(env["SUPATYPE_HOOK_SEND_EMAIL_SECRETS"]).toBe("")
  })

  it("renders the captcha secret only while captcha is on", () => {
    const secrets = { "captcha.secret": "0xSECRET" }
    const on = authSettingsToEnv({ auth: { captcha: { enabled: true, provider: "turnstile" } } }, { ...ctx, secrets })
    expect(on["SUPATYPE_SECURITY_CAPTCHA_ENABLED"]).toBe("true")
    expect(on["SUPATYPE_SECURITY_CAPTCHA_PROVIDER"]).toBe("turnstile")
    expect(on["SUPATYPE_SECURITY_CAPTCHA_SECRET"]).toBe("0xSECRET")
    const off = authSettingsToEnv({ auth: { captcha: { enabled: false } } }, { ...ctx, secrets })
    expect(off["SUPATYPE_SECURITY_CAPTCHA_SECRET"]).toBe("")
  })

  it("renders required password characters as the server's colon-separated sets, with nothing a compose file cannot carry", () => {
    const env = authSettingsToEnv({ auth: { password: { minLength: 10, requiredCharacters: ["digit", "lower", "symbol"] } } }, ctx)
    expect(env["SUPATYPE_PASSWORD_MIN_LENGTH"]).toBe("10")
    const sets = (env["SUPATYPE_PASSWORD_REQUIRED_CHARACTERS"] ?? "").split(":")
    expect(sets).toHaveLength(3)
    expect(sets[0]).toBe("abcdefghijklmnopqrstuvwxyz")
    expect(env["SUPATYPE_PASSWORD_REQUIRED_CHARACTERS"]).not.toMatch(/[$"'{}\\]/)
  })

  it("renders the SMS provider and the credential of the chosen provider only", () => {
    const settings: AuthSettings = {
      auth: { phone: { enabled: true, provider: "twilio", twilio: { accountSid: "AC1", authToken: "env(TW)" } } },
    }
    const env = authSettingsToEnv(settings, { ...ctx, secrets: { "phone.twilio.authToken": "tok", "phone.vonage.apiSecret": "old" } })
    expect(env["SUPATYPE_EXTERNAL_PHONE_ENABLED"]).toBe("true")
    expect(env["SUPATYPE_SMS_PROVIDER"]).toBe("twilio")
    expect(env["SUPATYPE_SMS_TWILIO_ACCOUNT_SID"]).toBe("AC1")
    expect(env["SUPATYPE_SMS_TWILIO_AUTH_TOKEN"]).toBe("tok")
    expect(env["SUPATYPE_SMS_VONAGE_API_SECRET"]).toBe("")
  })

  it("turns SAML on only when the platform holds its key, and gives the server its URL", () => {
    const settings: AuthSettings = { auth: { sso: { saml: { enabled: true, relayStateValidity: 300 } } } }
    const without = authSettingsToEnv(settings, { ...ctx, samlExternalUrl: "https://abc.supatype.io/auth/v1" })
    expect(without["SUPATYPE_SAML_ENABLED"]).toBe("false")
    const withKey = authSettingsToEnv(settings, {
      ...ctx,
      samlExternalUrl: "https://abc.supatype.io/auth/v1",
      secrets: { [SAML_PRIVATE_KEY_SECRET]: "KEY" },
    })
    expect(withKey["SUPATYPE_SAML_ENABLED"]).toBe("true")
    expect(withKey["SUPATYPE_SAML_PRIVATE_KEY"]).toBe("KEY")
    expect(withKey["SUPATYPE_SAML_EXTERNAL_URL"]).toBe("https://abc.supatype.io/auth/v1")
    expect(withKey["SUPATYPE_SAML_RELAY_STATE_VALIDITY_PERIOD"]).toBe("300s")
  })

  it("renders the next SAML key during a rotation, and only while SAML is on", () => {
    // Self-host rotates with a second key in .env; Cloud held one key and could not rotate at all.
    const on: AuthSettings = { auth: { sso: { saml: { enabled: true } } } }
    const secrets = { [SAML_PRIVATE_KEY_SECRET]: "KEY", [SAML_NEXT_PRIVATE_KEY_SECRET]: "NEXT" }
    expect(authSettingsToEnv(on, { ...ctx, secrets })["SUPATYPE_SAML_NEXT_PRIVATE_KEY"]).toBe("NEXT")
    expect(authSettingsToEnv({}, { ...ctx, secrets })["SUPATYPE_SAML_NEXT_PRIVATE_KEY"]).toBe("")
    expect(isAuthSecretKey(SAML_NEXT_PRIVATE_KEY_SECRET)).toBe(false)
  })

  it("never owns the platform's email limit", () => {
    expect(AUTH_OWNED_KEYS).not.toContain("SUPATYPE_RATE_LIMIT_EMAIL_SENT")
    expect(AUTH_OWNED_KEYS).not.toContain("SUPATYPE_RATE_LIMIT_HEADER")
  })
})

describe("group settings validation", () => {
  const check = (auth: object, target: "cloud" | "self-host" = "cloud"): string[] => validateAuthSettings({ auth }, target)

  it("accepts a full set of valid groups", () => {
    expect(
      check({
        hooks: {
          customAccessToken: { uri: "https://fn.example.com/a", secrets: "env(A)" },
          afterUserCreated: { uri: "pg-functions://postgres/public/after_user" },
        },
        captcha: { enabled: true, provider: "hcaptcha", secret: "env(CAPTCHA)" },
        password: { minLength: 12, requiredCharacters: ["lower", "upper"], leakedPasswordCheck: true },
        sessions: { timebox: 604800, inactivityTimeout: 86400, singlePerUser: true },
        security: { refreshTokenRotation: true, refreshTokenReuseInterval: 10, manualLinking: true },
        mfa: { totp: { enroll: true, verify: true }, phone: { enroll: false }, maxEnrolledFactors: 5 },
        anonymous: { enabled: true },
        phone: { enabled: true, provider: "vonage", vonage: { apiKey: "k", apiSecret: "env(V)", from: "Acme" } },
        rateLimits: { otp: 20, mfa: 10 },
        sso: { saml: { enabled: true, rateLimitAssertion: 20 } },
      }),
    ).toEqual([])
  })

  it("refuses a hook that is not https or a Postgres function, and http outside self-host localhost", () => {
    expect(check({ hooks: { sendEmail: { uri: "ftp://x.example.com" } } })[0]).toMatch(/must be an https URL/)
    expect(check({ hooks: { sendEmail: { uri: "http://localhost:54321/hook" } } }, "cloud")[0]).toMatch(/must be an https URL/)
    expect(check({ hooks: { sendEmail: { uri: "http://localhost:54321/hook" } } }, "self-host")).toEqual([])
  })

  it("requires a uri while a hook is enabled", () => {
    expect(check({ hooks: { sendEmail: { secrets: "env(X)" } } })[0]).toMatch(/uri is required/)
    expect(check({ hooks: { sendEmail: { enabled: false } } })).toEqual([])
  })

  it("refuses a literal secret on both targets, and unknown fields", () => {
    expect(check({ captcha: { enabled: true, secret: "literal" } }, "self-host")[0]).toMatch(/not hold the secret/)
    expect(check({ hooks: { sendEmail: { uri: "https://x.example.com", secrets: GOOD_SECRET } } })[0]).toMatch(/not hold the secret/)
    expect(check({ sessions: { timeout: 5 } })[0]).toMatch(/unknown field\(s\) timeout/)
    expect(check({ mfa: { totp: { enrol: true } } })[0]).toMatch(/unknown field\(s\) enrol/)
  })

  it("keeps numbers and choices in range", () => {
    expect(check({ password: { minLength: 3 } })[0]).toMatch(/minLength must be a whole number, 6 to 72/)
    expect(check({ sessions: { timebox: 5 } })[0]).toMatch(/timebox/)
    expect(check({ rateLimits: { otp: 0 } })[0]).toMatch(/rateLimits.otp/)
    expect(check({ rateLimits: { emailSent: 5 } })[0]).toMatch(/unknown field\(s\) emailSent/)
    expect(check({ captcha: { provider: "recaptcha" } })[0]).toMatch(/one of hcaptcha, turnstile/)
    expect(check({ password: { requiredCharacters: ["emoji"] } })[0]).toMatch(/list of lower, upper, digit, symbol/)
  })

  it("refuses text that could end a quoted line early", () => {
    expect(check({ phone: { twilio: { accountSid: 'AC"1' } } })[0]).toMatch(/cannot contain/)
    expect(check({ phone: { twilio: { accountSid: "AC${X}" } } })[0]).toMatch(/cannot contain/)
  })
})

describe("group secrets", () => {
  const settings: AuthSettings = {
    auth: {
      hooks: { sendEmail: { uri: "https://x.example.com", secrets: "env(HOOK_SECRET)" } },
      captcha: { enabled: true, secret: "env(CAPTCHA_SECRET)" },
      phone: { provider: "messagebird", messagebird: { accessKey: "env(MB_KEY)" } },
    },
  }

  it("lists each secret reference with its key", () => {
    expect(authSecretRefs(settings)).toEqual([
      { key: "hooks.sendEmail.secrets", envName: "HOOK_SECRET" },
      { key: "captcha.secret", envName: "CAPTCHA_SECRET" },
      { key: "phone.messagebird.accessKey", envName: "MB_KEY" },
    ])
  })

  it("knows which stored secrets the settings use", () => {
    expect(authSecretInUse(settings, "captcha.secret")).toBe(true)
    expect(authSecretInUse(settings, "hooks.sendSms.secrets")).toBe(false)
    expect(authSecretInUse(settings, "phone.twilio.authToken")).toBe(false)
    expect(authSecretInUse({}, SAML_PRIVATE_KEY_SECRET)).toBe(false)
    expect(authSecretInUse({ auth: { sso: { saml: { enabled: true } } } }, SAML_PRIVATE_KEY_SECRET)).toBe(true)
  })

  it("names the secrets an enabled feature cannot work without", () => {
    expect(groupRequiredSecretKeys(settings).sort()).toEqual(["captcha.secret", "phone.messagebird.accessKey"])
    expect(groupRequiredSecretKeys({ auth: { captcha: { enabled: false } } })).toEqual([])
  })

  it("accepts a Standard Webhooks hook secret and refuses anything else", () => {
    expect(groupSecretFormatProblem("hooks.sendEmail.secrets", GOOD_SECRET)).toBeUndefined()
    expect(groupSecretFormatProblem("hooks.sendEmail.secrets", `${GOOD_SECRET}|${GOOD_SECRET}`)).toBeUndefined()
    expect(groupSecretFormatProblem("hooks.sendEmail.secrets", "plain")).toMatch(/v1,whsec_/)
    expect(groupSecretFormatProblem("captcha.secret", "anything")).toBeUndefined()
  })

  it("makes the secrets settable, but never the platform's SAML key", () => {
    expect(isAuthSecretKey("hooks.sendEmail.secrets")).toBe(true)
    expect(isAuthSecretKey("phone.vonage.apiSecret")).toBe(true)
    expect(isAuthSecretKey(SAML_PRIVATE_KEY_SECRET)).toBe(false)
  })
})

describe("group settings as leaves", () => {
  it("flattens and unflattens them, with a listed hook's enabled explicit", () => {
    const settings: AuthSettings = {
      auth: {
        hooks: { sendEmail: { uri: "https://x.example.com", secrets: "env(S)" } },
        sessions: { timebox: 3600 },
        password: { requiredCharacters: ["digit"] },
      },
    }
    const flat = flattenAuthSettings(settings)
    expect(flat["auth.hooks.sendEmail.enabled"]).toBe(true)
    expect(flat["auth.hooks.sendEmail.uri"]).toBe("https://x.example.com")
    expect(flat["auth.sessions.timebox"]).toBe(3600)
    expect(flat["auth.password.requiredCharacters"]).toEqual(["digit"])
    expect(Object.keys(flat).some((k) => k.endsWith("secrets"))).toBe(false)
    expect(unflattenAuthSettings(flat).auth?.sessions?.timebox).toBe(3600)
    expect(unflattenAuthSettings(flat).auth?.hooks?.sendEmail?.uri).toBe("https://x.example.com")
  })

  it("accepts the new paths and refuses the platform-owned ones", () => {
    expect(isAuthSettingPath("auth.mfa.totp.enroll")).toBe(true)
    expect(isAuthSettingPath("auth.rateLimits.otp")).toBe(true)
    expect(isAuthSettingPath("auth.rateLimits.emailSent")).toBe(false)
    expect(isAuthSettingPath("auth.sso.saml.externalUrl")).toBe(false)
  })
})

describe("groupsSelfHostVars", () => {
  it("is empty for settings that set none of the groups", () => {
    expect(groupsSelfHostVars({ auth: { siteUrl: "https://x.example.com", disableSignup: true } })).toEqual([])
  })

  it("renders only what is stated, a secret as the name of its variable, and leaves SAML to the CLI", () => {
    const vars = groupsSelfHostVars({
      auth: {
        sessions: { singlePerUser: true },
        captcha: { enabled: true, secret: "env(CAPTCHA)" },
        hooks: { sendEmail: { uri: "https://x.example.com" } },
        sso: { saml: { enabled: true } },
      },
    })
    expect(vars).toContainEqual({ key: "SUPATYPE_SESSIONS_SINGLE_PER_USER", value: "true" })
    expect(vars).toContainEqual({ key: "SUPATYPE_SECURITY_CAPTCHA_SECRET", fromEnv: "CAPTCHA" })
    expect(vars).toContainEqual({ key: "SUPATYPE_HOOK_SEND_EMAIL_ENABLED", value: "true" })
    expect(vars).toContainEqual({ key: "SUPATYPE_HOOK_SEND_EMAIL_URI", value: "https://x.example.com" })
    expect(vars.some((v) => v.key.startsWith("SUPATYPE_SAML"))).toBe(false)
    expect(vars.some((v) => v.key === "SUPATYPE_SESSIONS_TIMEBOX")).toBe(false)
  })
})
