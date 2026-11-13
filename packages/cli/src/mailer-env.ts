/**
 * The auth server's mailer settings, shared by native dev, docker dev and the self-host compose file.
 *
 * Each path used to build its own, and they had drifted: native dev sent Resend and SES settings
 * under names the server never reads (RESEND_API_KEY rather than SUPATYPE_RESEND_API_KEY), docker
 * dev sent none of them, and only the compose file set the verify paths, so native dev's emailed
 * links all 404'd.
 */

import type { SupatypeProjectConfig } from "./project-config.js"
import { envReferenceName } from "@supatype/types"

type EmailConfig = SupatypeProjectConfig["email"]

/** The shell and `.env` as native dev sees them, to resolve an `env("NAME")` secret from. */
export type MailerEnvironment = Readonly<Record<string, string | undefined>>

/**
 * A secret from the config: a literal as written, an `env("NAME")` as the variable's value in
 * `environment`. With no environment, or the variable unset, a reference gives nothing, so the
 * reference itself is never written anywhere as if it were the secret.
 */
function secretValue(value: string | undefined, environment: MailerEnvironment | undefined): string | undefined {
  if (value === undefined || value === "") return undefined
  const name = envReferenceName(value)
  if (name === undefined) return value
  const resolved = environment?.[name]
  return resolved === undefined || resolved === "" ? undefined : resolved
}

/** The variable names `email.smtp.pass` and `email.resend_api_key` point at, by the name the server reads. */
export function mailerSecretReferences(email: EmailConfig): Record<string, string> {
  const candidates: [string, string | undefined][] = [
    ["SUPATYPE_SMTP_PASS", email?.smtp?.pass],
    ["SUPATYPE_RESEND_API_KEY", email?.resend_api_key],
  ]
  const refs: Record<string, string> = {}
  for (const [serverName, value] of candidates) {
    const name = value === undefined ? undefined : envReferenceName(value)
    if (name !== undefined) refs[serverName] = name
  }
  return refs
}

/**
 * Where every emailed auth link points. The server resolves each link's path against
 * SUPATYPE_API_EXTERNAL_URL, and its default of the absolute path `/verify` replaces whatever path
 * that URL had, so a link built against `<origin>/auth/v1` landed on `<origin>/verify`, which the
 * app owns. The auth routes are under `/auth/v1/`.
 */
export const AUTH_VERIFY_PATH = "/auth/v1/verify"

/** The four SUPATYPE_MAILER_URLPATHS_* the server builds links from, all at {@link AUTH_VERIFY_PATH}. */
export function mailerUrlPathsEnv(): Record<string, string> {
  return {
    SUPATYPE_MAILER_URLPATHS_CONFIRMATION: AUTH_VERIFY_PATH,
    SUPATYPE_MAILER_URLPATHS_INVITE: AUTH_VERIFY_PATH,
    SUPATYPE_MAILER_URLPATHS_RECOVERY: AUTH_VERIFY_PATH,
    SUPATYPE_MAILER_URLPATHS_EMAIL_CHANGE: AUTH_VERIFY_PATH,
  }
}

/** Server environment names the compose file passes through from `.env` for Resend and SES. */
export const MAILER_PASSTHROUGH_ENV = ["SUPATYPE_RESEND_API_KEY", "SUPATYPE_RESEND_FROM", "SUPATYPE_SES_FROM"] as const

/** Every SUPATYPE_SMTP_* name {@link mailerProviderEnv} can give, from `email.smtp`. */
export const SMTP_ENV = [
  "SUPATYPE_SMTP_HOST",
  "SUPATYPE_SMTP_PORT",
  "SUPATYPE_SMTP_USER",
  "SUPATYPE_SMTP_PASS",
  "SUPATYPE_SMTP_ADMIN_EMAIL",
  "SUPATYPE_SMTP_SENDER_NAME",
] as const

/** The name the server picks its mailer by, which {@link mailerProviderEnv} always gives. */
export const MAILER_PROVIDER_ENV = "SUPATYPE_MAILER_MAILER_PROVIDER"

/** A trimmed value, or undefined when there is nothing left. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === "" ? undefined : trimmed
}

/** `email.smtp` as SUPATYPE_SMTP_*, leaving out what it does not set so `.env` can. */
function smtpEnv(smtp: NonNullable<EmailConfig>["smtp"], environment: MailerEnvironment | undefined): Record<string, string> {
  if (smtp === undefined) return {}
  const out: Record<string, string> = {}
  const host = present(smtp.host)
  if (host !== undefined) out.SUPATYPE_SMTP_HOST = host
  if (smtp.port !== undefined) out.SUPATYPE_SMTP_PORT = String(smtp.port)
  const user = present(smtp.user)
  if (user !== undefined) out.SUPATYPE_SMTP_USER = user
  // A password is taken as written: surrounding spaces can be part of it.
  const pass = secretValue(smtp.pass, environment)
  if (pass !== undefined) out.SUPATYPE_SMTP_PASS = pass
  const admin = present(smtp.admin_email)
  if (admin !== undefined) out.SUPATYPE_SMTP_ADMIN_EMAIL = admin
  const sender = present(smtp.sender_name)
  if (sender !== undefined) out.SUPATYPE_SMTP_SENDER_NAME = sender
  return out
}

/** Resend's or SES's settings from the config, under the names the server reads. */
function apiProviderEnv(email: NonNullable<EmailConfig>, environment: MailerEnvironment | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (email.provider === "resend") {
    const key = present(secretValue(email.resend_api_key, environment))
    if (key !== undefined) out.SUPATYPE_RESEND_API_KEY = key
    const from = present(email.resend_from)
    if (from !== undefined) out.SUPATYPE_RESEND_FROM = from
  } else if (email.provider === "ses") {
    const from = present(email.ses_from)
    if (from !== undefined) out.SUPATYPE_SES_FROM = from
  }
  return out
}

/**
 * `email.provider` and its settings as the auth server's environment. Console is the documented
 * default, and it at least logs that a message would have been sent.
 *
 * An `env("NAME")` password or Resend key is read from `environment`; without one it is left out,
 * and the compose file names the variable instead (see {@link mailerSecretReferences}).
 */
export function mailerProviderEnv(email: EmailConfig, environment?: MailerEnvironment): Record<string, string> {
  const provider = email?.provider ?? "console"
  return {
    // Mailer.MailerProvider, so the doubled word is the real name.
    [MAILER_PROVIDER_ENV]: provider,
    ...(email !== undefined && provider === "smtp" ? smtpEnv(email.smtp, environment) : {}),
    ...(email !== undefined ? apiProviderEnv(email, environment) : {}),
  }
}

/**
 * `.env` as native dev lays it over {@link mailerProviderEnv}, less any blank value that would erase
 * one `email` in supatype.config.ts sets. init scaffolds a provider's names into `.env` with nothing
 * after the `=`, to be filled in, and those blanks used to replace the config's SMTP host or Resend
 * key, so the server fell back to its noop mailer. A value in `.env` still wins, and a blank still
 * applies to a name the config leaves unset. Docker dev needs none of this: it writes these names
 * into `.env` from the config.
 */
export function withoutBlankMailerOverrides(
  dotEnv: Record<string, string>,
  configMailerEnv: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dotEnv).filter(([name, value]) => value.trim() !== "" || (configMailerEnv[name] ?? "") === ""),
  )
}
