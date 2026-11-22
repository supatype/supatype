import { describe, expect, it } from "vitest"
import { composeAuthGroupsEnv, nativeAuthGroupsEnv } from "../src/auth-groups-env.js"
import { nativeAuthMailerEnv } from "../src/native-dev-env.js"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

const SECRET = "v1,whsec_abcdefghijklmnopqrstuvwxyz01234567"

function config(auth?: Record<string, unknown>, email?: Record<string, unknown>): SupatypeProjectConfig {
  return validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode: "standalone" as const },
      app: { mode: "none" as const },
      database: { provider: "docker" as const },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
      ...(auth !== undefined && { auth }),
      ...(email !== undefined && { email }),
    },
    "supatype.config.ts",
  )
}

const groups = {
  hooks: { sendEmail: { uri: "https://hooks.example.com/email", secrets: "env(EMAIL_HOOK_SECRETS)" } },
  captcha: { enabled: true, provider: "turnstile", secret: "env(CAPTCHA_SECRET)", siteKey: "0x4AAAAAAAsite" },
  password: { minLength: 10, requiredCharacters: ["lower", "digit"] },
  sessions: { timebox: 86400 },
  rateLimits: { otp: 50 },
  sso: { saml: { enabled: true } },
}

describe("auth settings groups in the compose file", () => {
  it("writes nothing for a config that sets none of them", () => {
    expect(composeAuthGroupsEnv(config())).toBe("")
    expect(composeAuthGroupsEnv(config({ siteUrl: "https://a.example.com" }))).toBe("")
  })

  it("writes a default a value in .env wins over, and a secret as the name of its variable", () => {
    const lines = composeAuthGroupsEnv(config(groups))
    expect(lines).toContain('      SUPATYPE_HOOK_SEND_EMAIL_URI: "${SUPATYPE_HOOK_SEND_EMAIL_URI:-https://hooks.example.com/email}"\n')
    expect(lines).toContain('      SUPATYPE_HOOK_SEND_EMAIL_ENABLED: "${SUPATYPE_HOOK_SEND_EMAIL_ENABLED:-true}"\n')
    expect(lines).toContain('      SUPATYPE_HOOK_SEND_EMAIL_SECRETS: "${SUPATYPE_HOOK_SEND_EMAIL_SECRETS:-${EMAIL_HOOK_SECRETS:-}}"\n')
    expect(lines).toContain('      SUPATYPE_SECURITY_CAPTCHA_SECRET: "${SUPATYPE_SECURITY_CAPTCHA_SECRET:-${CAPTCHA_SECRET:-}}"\n')
    expect(lines).toContain('      SUPATYPE_SECURITY_CAPTCHA_SITE_KEY: "${SUPATYPE_SECURITY_CAPTCHA_SITE_KEY:-0x4AAAAAAAsite}"\n')
    expect(lines).toContain('      SUPATYPE_PASSWORD_MIN_LENGTH: "${SUPATYPE_PASSWORD_MIN_LENGTH:-10}"\n')
    expect(lines).toContain('      SUPATYPE_SESSIONS_TIMEBOX: "${SUPATYPE_SESSIONS_TIMEBOX:-86400s}"\n')
  })

  it("leaves SAML to saml-config, so its variables are not written here", () => {
    expect(composeAuthGroupsEnv(config(groups))).not.toContain("SUPATYPE_SAML_")
  })

  it("sits in the server service of the rendered compose file", () => {
    const compose = renderSelfHostCompose(config(groups))
    expect(compose).toContain('SUPATYPE_RATE_LIMIT_OTP: "${SUPATYPE_RATE_LIMIT_OTP:-50}"')
    expect(renderSelfHostCompose(config())).not.toContain("SUPATYPE_RATE_LIMIT_OTP")
  })

  it("lets auth.hooks.sendEmail be the only send-email hook the compose file carries", () => {
    const compose = renderSelfHostCompose(config(groups, { send_email_hook: true }))
    expect(compose.match(/^ +SUPATYPE_HOOK_SEND_EMAIL_URI:/gm)).toHaveLength(1)
    expect(compose).toContain("https://hooks.example.com/email")
  })
})

describe("auth settings groups in native dev", () => {
  it("resolves a secret from the environment and leaves it out when the variable is not set", () => {
    const cfg = config(groups)
    const set = nativeAuthGroupsEnv(cfg, { EMAIL_HOOK_SECRETS: SECRET, CAPTCHA_SECRET: "cap" })
    expect(set["SUPATYPE_HOOK_SEND_EMAIL_SECRETS"]).toBe(SECRET)
    expect(set["SUPATYPE_SECURITY_CAPTCHA_SECRET"]).toBe("cap")
    expect(set["SUPATYPE_PASSWORD_REQUIRED_CHARACTERS"]).toBe("abcdefghijklmnopqrstuvwxyz:0123456789")
    const unset = nativeAuthGroupsEnv(cfg, {})
    expect(unset).not.toHaveProperty("SUPATYPE_HOOK_SEND_EMAIL_SECRETS")
    expect(unset["SUPATYPE_HOOK_SEND_EMAIL_URI"]).toBe("https://hooks.example.com/email")
  })

  it("renders nothing for a config that sets none of them", () => {
    expect(nativeAuthGroupsEnv(config(), { EMAIL_HOOK_SECRETS: SECRET })).toEqual({})
  })

  it("has auth.hooks.sendEmail win over email.send_email_hook when spread after it", () => {
    const cfg = config({ hooks: { sendEmail: { uri: "https://hooks.example.com/email", secrets: "env(EMAIL_HOOK_SECRETS)" } } }, { send_email_hook: true })
    const environment = { EMAIL_HOOK_SECRETS: SECRET }
    const mailer = nativeAuthMailerEnv(cfg.email, "3001", environment)
    expect(mailer["SUPATYPE_HOOK_SEND_EMAIL_URI"]).toContain("/internal/v0hooks/send-email")
    const merged = { ...mailer, ...nativeAuthGroupsEnv(cfg, environment) }
    expect(merged["SUPATYPE_HOOK_SEND_EMAIL_URI"]).toBe("https://hooks.example.com/email")
    expect(merged["SUPATYPE_HOOK_SEND_EMAIL_SECRETS"]).toBe(SECRET)
  })
})

describe("auth settings groups in config validation", () => {
  it("accepts the groups", () => {
    expect(() => config(groups)).not.toThrow()
  })

  it("refuses a literal secret, naming the file and the path", () => {
    expect(() => config({ captcha: { enabled: true, secret: "literal" } })).toThrow(/^supatype\.config\.ts: auth\.captcha\.secret must name an environment variable/)
  })

  it("refuses an out-of-range value and an unknown field", () => {
    expect(() => config({ password: { minLength: 3 } })).toThrow(/auth\.password\.minLength/)
    expect(() => config({ mfa: { bogus: true } })).toThrow(/auth\.mfa has unknown field/)
  })

  it("refuses a hook uri the compose file cannot carry", () => {
    expect(() => config({ hooks: { sendEmail: { uri: "https://a.example.com/${X}" } } })).toThrow(/auth\.hooks\.sendEmail\.uri/)
  })

  it("still lets auth.sso.saml carry the self-host externalUrl", () => {
    expect(() => config({ sso: { saml: { enabled: true, externalUrl: "https://sso.example.com/auth/v1" } } })).not.toThrow()
  })
})
