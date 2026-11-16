import { describe, it, expect } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { configMailerEnv } from "../src/config-mailer-env.js"
import { mailerProviderEnv } from "../src/mailer-env.js"
import { nativeAuthMailerEnv } from "../src/native-dev-env.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * `email.smtp.pass` and `email.resend_api_key` take `env("NAME")` like a provider's secret does, and
 * `auth.siteUrl`, `auth.redirectUrls` and `auth.disableSignup` reach the self-host compose file. A
 * value in `.env` still wins over each, and a literal SMTP password keeps working on self-host.
 */
const SECRET = "smtp-secret-value-that-must-not-be-rendered"

function raw(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    project: { name: "acme" },
    server: { mode: "standalone" as const },
    app: { mode: "none" as const },
    database: { provider: "docker" as const },
    versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
    ...extra,
  }
}

const config = (extra: Record<string, unknown>): SupatypeProjectConfig => validateProjectConfig(raw(extra), "supatype.config.ts")

function serverEnv(compose: string): Map<string, string> {
  const block = /^ {2}server:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n)/m.exec(compose)?.[1] ?? ""
  const out = new Map<string, string>()
  for (const line of block.split("\n")) {
    const match = /^\s{6}([A-Z_]+):\s*(.*)$/.exec(line)
    if (match?.[1] !== undefined) out.set(match[1], (match[2] ?? "").replace(/^"|"$/g, ""))
  }
  return out
}

const smtp = (pass: string): Record<string, unknown> => ({ email: { provider: "smtp", smtp: { host: "smtp.example.com", pass } } })

describe("email secrets as env references", () => {
  it("accepts env(NAME) and a literal for the SMTP password", () => {
    expect(() => config(smtp('env(SMTP_PASS)'))).not.toThrow()
    expect(() => config(smtp(SECRET))).not.toThrow()
  })

  it("refuses a malformed env reference for the SMTP password and the Resend key", () => {
    expect(() => config(smtp("env(1BAD)"))).toThrow(/email\.smtp\.pass/)
    expect(() => config({ email: { provider: "resend", resend_api_key: "env( )" } })).toThrow(/email\.resend_api_key/)
  })

  it("names the variable in the compose file, never a value, and lets .env win", () => {
    const compose = renderSelfHostCompose(config(smtp("env(SMTP_PASS)")))
    expect(serverEnv(compose).get("SUPATYPE_SMTP_PASS")).toBe("${SUPATYPE_SMTP_PASS:-${SMTP_PASS:-}}")
    const resend = renderSelfHostCompose(config({ email: { provider: "resend", resend_api_key: "env(RESEND_KEY)" } }))
    expect(serverEnv(resend).get("SUPATYPE_RESEND_API_KEY")).toBe("${SUPATYPE_RESEND_API_KEY:-${RESEND_KEY:-}}")
  })

  it("never writes env(NAME) into .env as the password", () => {
    const { updates } = configMailerEnv(config(smtp("env(SMTP_PASS)")))
    expect(updates["SUPATYPE_SMTP_PASS"]).toBeUndefined()
    const resend = configMailerEnv(config({ email: { provider: "resend", resend_api_key: "env(RESEND_KEY)" } }))
    expect(resend.updates["SUPATYPE_RESEND_API_KEY"]).toBeUndefined()
  })

  it("resolves the reference from the environment in native dev, and leaves it out when unset", () => {
    const cfg = config(smtp("env(SMTP_PASS)"))
    expect(nativeAuthMailerEnv(cfg.email, "3001", { SMTP_PASS: SECRET })["SUPATYPE_SMTP_PASS"]).toBe(SECRET)
    expect(nativeAuthMailerEnv(cfg.email, "3001", {})["SUPATYPE_SMTP_PASS"]).toBeUndefined()
    const resend = config({ email: { provider: "resend", resend_api_key: "env(RESEND_KEY)" } })
    expect(mailerProviderEnv(resend.email, { RESEND_KEY: "rk" })["SUPATYPE_RESEND_API_KEY"]).toBe("rk")
  })

  it("keeps a literal SMTP password in .env and out of the compose file", () => {
    const cfg = config(smtp(SECRET))
    expect(configMailerEnv(cfg).updates["SUPATYPE_SMTP_PASS"]).toBe(SECRET)
    expect(renderSelfHostCompose(cfg)).not.toContain(SECRET)
  })
})

describe("auth.siteUrl, auth.redirectUrls and auth.disableSignup", () => {
  it("validates each", () => {
    expect(() => config({ auth: { siteUrl: "not a url" } })).toThrow(/auth\.siteUrl/)
    expect(() => config({ auth: { redirectUrls: ["https://a.example.com", "nope"] } })).toThrow(/auth\.redirectUrls/)
    expect(() => config({ auth: { redirectUrls: ["https://a.example.com/${X}"] } })).toThrow(/auth\.redirectUrls/)
    expect(() => config({ auth: { disableSignup: "yes" } })).toThrow(/auth\.disableSignup/)
    expect(() => config({ auth: { siteUrl: "https://app.example.com", redirectUrls: ["https://app.example.com/**"], disableSignup: true } })).not.toThrow()
  })

  it("renders each when set, with .env still winning", () => {
    const env = serverEnv(
      renderSelfHostCompose(
        config({ auth: { siteUrl: "https://app.example.com", redirectUrls: ["https://a.example.com/**", "https://b.example.com/cb"], disableSignup: true } }),
      ),
    )
    expect(env.get("SUPATYPE_SITE_URL")).toBe("${SITE_URL:-https://app.example.com}")
    expect(env.get("SUPATYPE_URI_ALLOW_LIST")).toBe("${SUPATYPE_URI_ALLOW_LIST:-https://a.example.com/**,https://b.example.com/cb}")
    expect(env.get("SUPATYPE_DISABLE_SIGNUP")).toBe("${DISABLE_SIGNUP:-true}")
  })

  it("renders no allow list and the old defaults when none is set", () => {
    const env = serverEnv(renderSelfHostCompose(config({})))
    expect(env.has("SUPATYPE_URI_ALLOW_LIST")).toBe(false)
    expect(env.get("SUPATYPE_SITE_URL")).toBe("${SITE_URL:-http://localhost:3000}")
    expect(env.get("SUPATYPE_DISABLE_SIGNUP")).toBe("${DISABLE_SIGNUP:-false}")
  })
})
