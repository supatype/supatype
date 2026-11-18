import { describe, expect, it } from "vitest"
import {
  AUTH_OWNED_KEYS,
  AUTH_PROVIDER_NAMES,
  authSecretRefs,
  authSettingPaths,
  authSettingsToEnv,
  envReferenceName,
  flattenAuthSettings,
  isAuthSecretKey,
  parseAuthSettings,
  isAuthSettingPath,
  unflattenAuthSettings,
  renderEnvFile,
  validateAuthSettings,
  type AuthRenderContext,
  type AuthSettings,
} from "../src/auth-settings.js"

const ctx: AuthRenderContext = {
  callbackBaseUrl: "https://abc.supatype.io",
  siteUrl: "https://abc.supatype.io",
  platformRedirectUrls: ["https://studio.supatype.com/**"],
  secrets: {},
}

describe("authSettingsToEnv", () => {
  it("writes every owned key even when settings are empty, so a removed value is unset", () => {
    const env = authSettingsToEnv({}, ctx)
    expect(Object.keys(env).sort()).toEqual([...AUTH_OWNED_KEYS].sort())
    expect(env["SUPATYPE_EXTERNAL_GITHUB_ENABLED"]).toBe("false")
    expect(env["SUPATYPE_EXTERNAL_GITHUB_SKIP_NONCE_CHECK"]).toBe("false")
    expect(env["SUPATYPE_EXTERNAL_GITHUB_CLIENT_ID"]).toBe("")
  })

  it("covers all 25 providers", () => {
    expect(AUTH_PROVIDER_NAMES).toHaveLength(25)
    const env = authSettingsToEnv({}, ctx)
    for (const name of AUTH_PROVIDER_NAMES) {
      expect(env[`SUPATYPE_EXTERNAL_${name.toUpperCase()}_ENABLED`]).toBe("false")
    }
  })

  it("renders a configured provider with the callback under the callback base and its stored secret", () => {
    const settings: AuthSettings = {
      auth: { providers: { github: { clientId: "Iv1.abc", secret: "env(GITHUB_SECRET)" } } },
    }
    const env = authSettingsToEnv(settings, { ...ctx, secrets: { "providers.github.secret": "s3cret" } })
    expect(env["SUPATYPE_EXTERNAL_GITHUB_ENABLED"]).toBe("true")
    expect(env["SUPATYPE_EXTERNAL_GITHUB_CLIENT_ID"]).toBe("Iv1.abc")
    expect(env["SUPATYPE_EXTERNAL_GITHUB_SECRET"]).toBe("s3cret")
    expect(env["SUPATYPE_EXTERNAL_GITHUB_REDIRECT_URI"]).toBe("https://abc.supatype.io/auth/v1/callback")
  })

  it("keeps a provider turned off when enabled is false", () => {
    const env = authSettingsToEnv({ auth: { providers: { google: { enabled: false, clientId: "x" } } } }, ctx)
    expect(env["SUPATYPE_EXTERNAL_GOOGLE_ENABLED"]).toBe("false")
  })

  it("always includes the platform redirect entries in the allow list, after the project's own", () => {
    const env = authSettingsToEnv({ auth: { redirectUrls: ["https://app.example.com/**"] } }, ctx)
    expect(env["SUPATYPE_URI_ALLOW_LIST"]).toBe("https://app.example.com/**,https://studio.supatype.com/**")
    expect(authSettingsToEnv({}, ctx)["SUPATYPE_URI_ALLOW_LIST"]).toBe("https://studio.supatype.com/**")
  })

  it("takes the site URL from settings, else from the context", () => {
    expect(authSettingsToEnv({ auth: { siteUrl: "https://app.example.com" } }, ctx)["SUPATYPE_SITE_URL"]).toBe(
      "https://app.example.com",
    )
    expect(authSettingsToEnv({}, ctx)["SUPATYPE_SITE_URL"]).toBe("https://abc.supatype.io")
  })

  it("maps email and sign-up switches, with confirmations on unless turned off", () => {
    expect(authSettingsToEnv({}, ctx)["SUPATYPE_MAILER_AUTOCONFIRM"]).toBe("false")
    const off = authSettingsToEnv(
      { auth: { email: { enabled: false, enableConfirmations: false }, disableSignup: true } },
      ctx,
    )
    expect(off["SUPATYPE_EXTERNAL_EMAIL_ENABLED"]).toBe("false")
    expect(off["SUPATYPE_MAILER_AUTOCONFIRM"]).toBe("true")
    expect(off["SUPATYPE_DISABLE_SIGNUP"]).toBe("true")
  })

  it("renders smtp, with an integer port always present and the password from the stored secret", () => {
    const settings: AuthSettings = {
      email: {
        provider: "smtp",
        smtp: { host: "smtp.x.com", port: 2525, user: "u", pass: "env(SMTP_PASS)", sender_name: "Acme" },
      },
    }
    const env = authSettingsToEnv(settings, { ...ctx, secrets: { "email.smtp.pass": "pw" } })
    expect(env["SUPATYPE_MAILER_MAILER_PROVIDER"]).toBe("smtp")
    expect(env["SUPATYPE_SMTP_HOST"]).toBe("smtp.x.com")
    expect(env["SUPATYPE_SMTP_PORT"]).toBe("2525")
    expect(env["SUPATYPE_SMTP_PASS"]).toBe("pw")
    expect(env["SUPATYPE_SMTP_SENDER_NAME"]).toBe("Acme")
    expect(authSettingsToEnv({}, ctx)["SUPATYPE_SMTP_PORT"]).toBe("587")
  })

  it("renders resend", () => {
    const env = authSettingsToEnv(
      { email: { provider: "resend", resend_api_key: "env(RESEND_KEY)", resend_from: "a@b.com" } },
      { ...ctx, secrets: { "email.resend_api_key": "re_123" } },
    )
    expect(env["SUPATYPE_MAILER_MAILER_PROVIDER"]).toBe("resend")
    expect(env["SUPATYPE_RESEND_API_KEY"]).toBe("re_123")
    expect(env["SUPATYPE_RESEND_FROM"]).toBe("a@b.com")
  })

  it("uses the platform mail defaults when the project sets no provider", () => {
    const env = authSettingsToEnv(
      {},
      {
        ...ctx,
        platformMail: {
          host: "mail.supatype.io",
          port: 587,
          user: "p",
          pass: "pp",
          senderName: "Supatype",
          adminEmail: "no-reply@auth.supatype.io",
        },
      },
    )
    expect(env["SUPATYPE_MAILER_MAILER_PROVIDER"]).toBe("smtp")
    expect(env["SUPATYPE_SMTP_HOST"]).toBe("mail.supatype.io")
    expect(env["SUPATYPE_SMTP_ADMIN_EMAIL"]).toBe("no-reply@auth.supatype.io")
  })

  it("never sets a platform-owned key", () => {
    const env = authSettingsToEnv({}, ctx)
    for (const key of ["SUPATYPE_JWT_SECRET", "SUPATYPE_DB_DATABASE_URL", "SUPATYPE_API_EXTERNAL_URL", "SUPATYPE_JWT_EXP"]) {
      expect(Object.keys(env)).not.toContain(key)
      expect(AUTH_OWNED_KEYS).not.toContain(key)
    }
    expect(Object.keys(env).filter((k) => k.startsWith("SUPATYPE_MAILER_URLPATHS_"))).toEqual([])
  })
})

describe("validateAuthSettings", () => {
  it("accepts the self-host config shape", () => {
    const ok = { auth: { providers: { github: { clientId: "x", secret: "env(A)" } } } }
    expect(validateAuthSettings(ok, "self-host")).toEqual([])
  })

  it("refuses a literal provider secret on both targets", () => {
    const bad = { auth: { providers: { github: { secret: "literal" } } } }
    expect(validateAuthSettings(bad, "cloud")[0]).toContain("auth.providers.github.secret")
    expect(validateAuthSettings(bad, "self-host")[0]).toContain("auth.providers.github.secret")
  })

  it("accepts env() for smtp.pass, and refuses a literal for Cloud only", () => {
    const ref = { email: { provider: "smtp", smtp: { pass: "env(SMTP_PASS)" } } }
    expect(validateAuthSettings(ref, "cloud")).toEqual([])
    const literal = { email: { provider: "smtp", smtp: { pass: "hunter2" } } }
    expect(validateAuthSettings(literal, "self-host")).toEqual([])
    expect(validateAuthSettings(literal, "cloud")[0]).toContain("email.smtp.pass")
  })

  it("refuses a literal resend key on Cloud, and ses on Cloud", () => {
    expect(validateAuthSettings({ email: { provider: "resend", resend_api_key: "re_x" } }, "cloud")[0]).toContain(
      "resend_api_key",
    )
    expect(validateAuthSettings({ email: { provider: "ses" } }, "cloud")[0]).toContain("ses")
    expect(validateAuthSettings({ email: { provider: "ses" } }, "self-host")).toEqual([])
  })

  it("refuses unknown providers, unknown fields and bad URLs", () => {
    expect(validateAuthSettings({ auth: { providers: { nope: {} } } }, "cloud")[0]).toContain("nope")
    expect(validateAuthSettings({ auth: { providers: { github: { bogus: 1 } } } }, "cloud")[0]).toContain("bogus")
    expect(validateAuthSettings({ auth: { siteUrl: "javascript:alert(1)" } }, "cloud")[0]).toContain("auth.siteUrl")
    expect(validateAuthSettings({ auth: { redirectUrls: ["not a url"] } }, "cloud")[0]).toContain("auth.redirectUrls")
  })

  it("allows a custom-scheme redirect URL for an app, and still refuses schemes dangerous in a browser", () => {
    const ok = ["myapp://login-callback/", "com.example.app:/oauth2redirect", "exp+myapp://**", "https://app.example.com/**"]
    expect(validateAuthSettings({ auth: { redirectUrls: ok } }, "cloud")).toEqual([])
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "vbscript:x", "JavaScript:alert(1)", "1app://x", "://x", "myapp:"]) {
      expect(validateAuthSettings({ auth: { redirectUrls: [bad] } }, "cloud")[0]).toContain("auth.redirectUrls")
    }
  })

  it("keeps the site URL and a provider's URLs to http(s)", () => {
    expect(validateAuthSettings({ auth: { siteUrl: "myapp://home" } }, "cloud")[0]).toContain("auth.siteUrl")
    expect(validateAuthSettings({ auth: { providers: { github: { redirectUri: "myapp://cb" } } } }, "cloud")[0]).toContain("redirectUri")
  })

  it("refuses a value that could end a quoted line early", () => {
    expect(validateAuthSettings({ auth: { providers: { github: { clientId: "a\nb" } } } }, "cloud")[0]).toContain(
      "auth.providers.github.clientId",
    )
  })
})

describe("authSecretRefs", () => {
  it("lists each secret key with the env name it points at", () => {
    const refs = authSecretRefs({
      auth: { providers: { github: { secret: "env(GH)" }, google: { clientId: "x" } } },
      email: { provider: "smtp", smtp: { pass: "env(SMTP_PASS)" } },
    })
    expect(refs).toEqual([
      { key: "providers.github.secret", envName: "GH" },
      { key: "email.smtp.pass", envName: "SMTP_PASS" },
    ])
  })
})

describe("renderEnvFile", () => {
  it("writes sorted single-quoted lines, leaving $ and backslashes as they are", () => {
    expect(renderEnvFile({ B: "2", A: "a $b \\ c" })).toBe("A='a $b \\ c'\nB='2'\n")
  })

  it("refuses a value with a control character or a single quote", () => {
    expect(() => renderEnvFile({ A: "line\nbreak" })).toThrow(/A/)
    expect(() => renderEnvFile({ A: "it's" })).toThrow(/A/)
  })
})

describe("envReferenceName", () => {
  it("reads env(NAME) and ignores literals", () => {
    expect(envReferenceName("env(X_1)")).toBe("X_1")
    expect(envReferenceName("literal")).toBeUndefined()
  })
})

describe("flattenAuthSettings and unflattenAuthSettings", () => {
  const settings: AuthSettings = {
    auth: {
      siteUrl: "https://app.example.com",
      redirectUrls: ["https://app.example.com/**"],
      email: { enableConfirmations: false },
      providers: { github: { clientId: "Iv1", secret: "env(GH)" }, google: { enabled: false } },
    },
    email: { provider: "smtp", smtp: { host: "h", port: 25, pass: "env(P)" } },
  }

  it("makes one leaf per setting, with a provider's enabled always explicit and no secrets", () => {
    expect(flattenAuthSettings(settings)).toEqual({
      "auth.siteUrl": "https://app.example.com",
      "auth.redirectUrls": ["https://app.example.com/**"],
      "auth.email.enableConfirmations": false,
      "auth.providers.github.enabled": true,
      "auth.providers.github.clientId": "Iv1",
      "auth.providers.google.enabled": false,
      "email.provider": "smtp",
      "email.smtp.host": "h",
      "email.smtp.port": 25,
    })
  })

  it("round-trips the leaves back into settings", () => {
    const flat = flattenAuthSettings(settings)
    expect(flattenAuthSettings(unflattenAuthSettings(flat))).toEqual(flat)
    expect(unflattenAuthSettings(flat).auth?.providers?.github?.clientId).toBe("Iv1")
  })

  it("lists the paths a setting may have and refuses others", () => {
    expect(isAuthSettingPath("auth.providers.github.clientId")).toBe(true)
    expect(isAuthSettingPath("auth.providers.github.secret")).toBe(false)
    expect(isAuthSettingPath("auth.providers.nope.enabled")).toBe(false)
    expect(isAuthSettingPath("email.smtp.pass")).toBe(false)
    expect(isAuthSettingPath("SUPATYPE_JWT_SECRET")).toBe(false)
  })

  it("knows the secret keys", () => {
    expect(isAuthSecretKey("providers.github.secret")).toBe(true)
    expect(isAuthSecretKey("email.smtp.pass")).toBe(true)
    expect(isAuthSecretKey("providers.nope.secret")).toBe(false)
    expect(isAuthSecretKey("jwt")).toBe(false)
  })
})

describe("authSettingPaths", () => {
  it("lists every path isAuthSettingPath accepts, and nothing else", () => {
    const paths = authSettingPaths()
    expect(paths.length).toBeGreaterThan(25 * 5)
    expect(paths.every(isAuthSettingPath)).toBe(true)
    expect(paths).toContain("auth.siteUrl")
    expect(paths).toContain("auth.providers.zoom.enabled")
    expect(new Set(paths).size).toBe(paths.length)
  })
})

describe("parseAuthSettings", () => {
  it("narrows valid settings and lists the problems of invalid ones", () => {
    const ok = parseAuthSettings({ auth: { siteUrl: "https://a.com" } }, "cloud")
    expect(ok).toEqual({ ok: true, settings: { auth: { siteUrl: "https://a.com" } } })
    const bad = parseAuthSettings({ auth: { siteUrl: "nope" } }, "cloud")
    expect(bad.ok).toBe(false)
    expect(bad.ok ? [] : bad.problems[0]).toContain("auth.siteUrl")
  })
})
