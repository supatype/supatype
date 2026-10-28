import { describe, expect, it } from "vitest"
import { AUTH_VERIFY_PATH, mailerProviderEnv, mailerUrlPathsEnv } from "../src/mailer-env.js"
import { nativeAuthMailerEnv } from "../src/native-dev-env.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

type Email = SupatypeProjectConfig["email"]

/**
 * The auth server reads SUPATYPE_RESEND_API_KEY, SUPATYPE_RESEND_FROM and SUPATYPE_SES_FROM. Native
 * dev used to send RESEND_API_KEY, RESEND_FROM and SES_FROM, which it ignores, so a project that
 * asked for Resend or SES fell back to the noop mailer and no message was ever sent.
 */
describe("mailerProviderEnv", () => {
  it("defaults to console with nothing else", () => {
    expect(mailerProviderEnv(undefined)).toEqual({ SUPATYPE_MAILER_MAILER_PROVIDER: "console" })
  })

  it("sends Resend's key and sender under the names the server reads", () => {
    const email: Email = { provider: "resend", resend_api_key: "re_123", resend_from: " hi@acme.dev " }
    expect(mailerProviderEnv(email)).toEqual({
      SUPATYPE_MAILER_MAILER_PROVIDER: "resend",
      SUPATYPE_RESEND_API_KEY: "re_123",
      SUPATYPE_RESEND_FROM: "hi@acme.dev",
    })
  })

  it("sends SES's sender under the name the server reads", () => {
    expect(mailerProviderEnv({ provider: "ses", ses_from: "hi@acme.dev" })).toEqual({
      SUPATYPE_MAILER_MAILER_PROVIDER: "ses",
      SUPATYPE_SES_FROM: "hi@acme.dev",
    })
  })

  it("leaves out what the config does not set, so .env can supply it", () => {
    expect(mailerProviderEnv({ provider: "resend", resend_from: "  " })).toEqual({
      SUPATYPE_MAILER_MAILER_PROVIDER: "resend",
    })
  })

  it("carries SMTP settings only for the smtp provider", () => {
    const smtp = { host: " mail.acme.dev ", port: 2525, user: "u", pass: "p", sender_name: "Acme" }
    expect(mailerProviderEnv({ provider: "smtp", smtp })).toEqual({
      SUPATYPE_MAILER_MAILER_PROVIDER: "smtp",
      SUPATYPE_SMTP_HOST: "mail.acme.dev",
      SUPATYPE_SMTP_PORT: "2525",
      SUPATYPE_SMTP_USER: "u",
      SUPATYPE_SMTP_PASS: "p",
      SUPATYPE_SMTP_SENDER_NAME: "Acme",
    })
    expect(mailerProviderEnv({ provider: "console", smtp })).toEqual({
      SUPATYPE_MAILER_MAILER_PROVIDER: "console",
    })
  })
})

describe("mailerUrlPathsEnv", () => {
  it("points every emailed link at the auth route's verify endpoint", () => {
    expect(AUTH_VERIFY_PATH).toBe("/auth/v1/verify")
    expect(mailerUrlPathsEnv()).toEqual({
      SUPATYPE_MAILER_URLPATHS_CONFIRMATION: "/auth/v1/verify",
      SUPATYPE_MAILER_URLPATHS_INVITE: "/auth/v1/verify",
      SUPATYPE_MAILER_URLPATHS_RECOVERY: "/auth/v1/verify",
      SUPATYPE_MAILER_URLPATHS_EMAIL_CHANGE: "/auth/v1/verify",
    })
  })
})

/**
 * Native dev's external URL ends in /auth/v1, and the server resolves the default absolute path
 * "/verify" against it, which drops /auth/v1: every magic, confirmation and recovery link 404'd.
 */
describe("nativeAuthMailerEnv", () => {
  it("sets the verify paths, so links resolve under /auth/v1", () => {
    const env = nativeAuthMailerEnv({ provider: "console" }, "54321")
    expect(env.SUPATYPE_API_EXTERNAL_URL).toBe("http://localhost:54321/auth/v1")
    expect(new URL(env.SUPATYPE_MAILER_URLPATHS_RECOVERY ?? "/verify", env.SUPATYPE_API_EXTERNAL_URL).pathname).toBe(
      "/auth/v1/verify",
    )
    expect(env).toMatchObject(mailerUrlPathsEnv())
  })

  it("carries Resend's settings under the prefixed names", () => {
    const env = nativeAuthMailerEnv({ provider: "resend", resend_api_key: "re_1", resend_from: "a@b.c" }, "54321")
    expect(env).toMatchObject({ SUPATYPE_RESEND_API_KEY: "re_1", SUPATYPE_RESEND_FROM: "a@b.c" })
    expect(env).not.toHaveProperty("RESEND_API_KEY")
    expect(env).not.toHaveProperty("RESEND_FROM")
  })

  it("points the send-email hook at this server unless the config names one", () => {
    const env = nativeAuthMailerEnv({ provider: "console", send_email_hook: true }, "54321")
    expect(env.SUPATYPE_HOOK_SEND_EMAIL_ENABLED).toBe("true")
    expect(env.SUPATYPE_HOOK_SEND_EMAIL_URI).toBe("http://127.0.0.1:54321/internal/v0hooks/send-email")
    expect(env.SUPATYPE_HOOK_SEND_EMAIL_SECRETS).toMatch(/^v1,whsec_/)
  })
})
