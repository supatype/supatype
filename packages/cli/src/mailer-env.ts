/**
 * The auth server's mailer settings, shared by native dev, docker dev and the self-host compose file.
 *
 * Each path used to build its own, and they had drifted: native dev sent Resend and SES settings
 * under names the server never reads (RESEND_API_KEY rather than SUPATYPE_RESEND_API_KEY), docker
 * dev sent none of them, and only the compose file set the verify paths, so native dev's emailed
 * links all 404'd.
 */

import type { SupatypeProjectConfig } from "./project-config.js"

type EmailConfig = SupatypeProjectConfig["email"]

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

/** A trimmed value, or undefined when there is nothing left. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === "" ? undefined : trimmed
}

/** `email.smtp` as SUPATYPE_SMTP_*, leaving out what it does not set so `.env` can. */
function smtpEnv(smtp: NonNullable<EmailConfig>["smtp"]): Record<string, string> {
  if (smtp === undefined) return {}
  const out: Record<string, string> = {}
  const host = present(smtp.host)
  if (host !== undefined) out.SUPATYPE_SMTP_HOST = host
  if (smtp.port !== undefined) out.SUPATYPE_SMTP_PORT = String(smtp.port)
  const user = present(smtp.user)
  if (user !== undefined) out.SUPATYPE_SMTP_USER = user
  // A password is taken as written: surrounding spaces can be part of it.
  if (smtp.pass !== undefined && smtp.pass !== "") out.SUPATYPE_SMTP_PASS = smtp.pass
  const admin = present(smtp.admin_email)
  if (admin !== undefined) out.SUPATYPE_SMTP_ADMIN_EMAIL = admin
  const sender = present(smtp.sender_name)
  if (sender !== undefined) out.SUPATYPE_SMTP_SENDER_NAME = sender
  return out
}

/** Resend's or SES's settings from the config, under the names the server reads. */
function apiProviderEnv(email: NonNullable<EmailConfig>): Record<string, string> {
  const out: Record<string, string> = {}
  if (email.provider === "resend") {
    const key = present(email.resend_api_key)
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
 */
export function mailerProviderEnv(email: EmailConfig): Record<string, string> {
  const provider = email?.provider ?? "console"
  return {
    // Mailer.MailerProvider, so the doubled word is the real name.
    SUPATYPE_MAILER_MAILER_PROVIDER: provider,
    ...(email !== undefined && provider === "smtp" ? smtpEnv(email.smtp) : {}),
    ...(email !== undefined ? apiProviderEnv(email) : {}),
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

/** The SMTP port the server defaults to, and the one the compose file writes for a blank value. */
const DEFAULT_SMTP_PORT = "587"

/**
 * `env`, what native dev starts the server with over `inherited` (its own environment), plus
 * `SUPATYPE_SMTP_PORT=587` when the port would otherwise reach the server blank. The server reads the
 * project's `.env` (`dotEnv`) itself and takes each name its environment leaves unset, so a blank
 * `SUPATYPE_SMTP_PORT=` there arrived as "" whatever the CLI passed, and the server would not start:
 * `converting '' to type int`, at `migrate` first. A name set in its environment, even blank, keeps
 * the file's from being read. The compose file has always written `${SUPATYPE_SMTP_PORT:-587}`.
 */
export function withSmtpPortFallback(
  env: Record<string, string>,
  dotEnv: Readonly<Record<string, string>>,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const name = "SUPATYPE_SMTP_PORT"
  const port = env[name] ?? inherited[name] ?? dotEnv[name]
  return port !== undefined && port.trim() === "" ? { ...env, [name]: DEFAULT_SMTP_PORT } : env
}
