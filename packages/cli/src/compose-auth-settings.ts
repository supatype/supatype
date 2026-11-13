/**
 * What `auth.siteUrl`, `auth.redirectUrls`, `auth.disableSignup` and an `env("NAME")` mailer secret
 * add to the self-host compose file's server service.
 *
 * Each is a fallback inside `${KEY:-...}`, so a value in `.env` still wins, and a config that sets
 * none of them renders exactly what it always did. A secret is the name of the variable holding it,
 * never the value.
 */
import { mailerSecretReferences, MAILER_PASSTHROUGH_ENV } from "./mailer-env.js"
import type { SupatypeProjectConfig } from "./project-config.js"

/** The password's compose expression: `.env`'s own variable first, then the one the config names. */
function secretExpression(serverName: string, referenced: string | undefined): string {
  return referenced === undefined ? `\${${serverName}:-}` : `\${${serverName}:-\${${referenced}:-}}`
}

/** `SUPATYPE_SMTP_PASS`'s value, as a compose expression. */
export function composeSmtpPass(config: SupatypeProjectConfig): string {
  return secretExpression("SUPATYPE_SMTP_PASS", mailerSecretReferences(config.email)["SUPATYPE_SMTP_PASS"])
}

/** Resend's key and sender and SES's sender, one `NAME: expression` line each. */
export function composeMailerPassthrough(config: SupatypeProjectConfig): Record<string, string> {
  const refs = mailerSecretReferences(config.email)
  return Object.fromEntries(MAILER_PASSTHROUGH_ENV.map((name) => [name, secretExpression(name, refs[name])]))
}

/** The fallback for `SITE_URL`: `auth.siteUrl` when set, else `defaultUrl`. */
export function composeSiteUrlFallback(config: SupatypeProjectConfig, defaultUrl: string): string {
  return config.auth?.siteUrl?.trim() || defaultUrl
}

/** `SUPATYPE_URI_ALLOW_LIST`, as a line, only when `auth.redirectUrls` is set. Else an empty string. */
export function composeAllowListLine(config: SupatypeProjectConfig): string {
  const urls = config.auth?.redirectUrls
  if (urls === undefined) return ""
  const key = "SUPATYPE_URI_ALLOW_LIST"
  return `      ${key}: "\${${key}:-${urls.map((url) => url.trim()).join(",")}}"\n`
}

/** The fallback for `DISABLE_SIGNUP`: `auth.disableSignup`, default false. */
export function composeDisableSignupFallback(config: SupatypeProjectConfig): string {
  return String(config.auth?.disableSignup ?? false)
}
