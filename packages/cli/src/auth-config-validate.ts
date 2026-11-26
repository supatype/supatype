/**
 * The `auth.siteUrl`, `auth.redirectUrls`, `auth.disableSignup` and email secret rules, checked with
 * the shared rules in `@supatype/types` so the CLI and the Cloud control plane agree on them.
 *
 * Only the fields this covers are handed over: `auth.providers` keeps its own checks
 * (`validateAuthProviders`), `auth.sso` keeps `validateAuthSso` (it also knows the self-host-only
 * `externalUrl`), and the rest of `email` was never validated, so a config that worked before still
 * loads. The settings groups (hooks, captcha, password and the rest) are handed over whole.
 */
import { validateAuthSettings } from "@supatype/types"
import { UNSAFE_LITERAL, isPlainObject } from "./auth-providers.js"
import { warn } from "./ui/messages.js"

/** The `auth` keys that are settings groups the shared rules check in full. */
const GROUP_KEYS = ["hooks", "captcha", "password", "sessions", "security", "mfa", "anonymous", "phone", "rateLimits"] as const

/** Values rendered into the compose file inside `"${KEY:-...}"`; a list is joined with commas. */
function unsafeProblems(auth: Record<string, unknown>): string[] {
  const siteUrl = auth["siteUrl"]
  const urls = auth["redirectUrls"]
  const problems: string[] = []
  if (typeof siteUrl === "string" && UNSAFE_LITERAL.test(siteUrl)) {
    problems.push("auth.siteUrl cannot contain $, braces, quotes, backslashes or control characters")
  }
  if (Array.isArray(urls) && urls.some((url) => typeof url === "string" && (UNSAFE_LITERAL.test(url) || url.includes(",")))) {
    problems.push("auth.redirectUrls entries cannot contain $, braces, quotes, backslashes, commas or control characters")
  }
  return problems
}

/** The part of `email` the shared rules check here: the provider and its secrets. */
function mailSubset(email: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(email)) return undefined
  const smtp = isPlainObject(email["smtp"]) ? email["smtp"] : undefined
  return {
    ...(email["provider"] !== undefined && { provider: email["provider"] }),
    ...(email["resend_api_key"] !== undefined && { resend_api_key: email["resend_api_key"] }),
    ...(email["ses_access_key_id"] !== undefined && { ses_access_key_id: email["ses_access_key_id"] }),
    ...(email["ses_secret_access_key"] !== undefined && { ses_secret_access_key: email["ses_secret_access_key"] }),
    ...(smtp?.["pass"] !== undefined && { smtp: { pass: smtp["pass"] } }),
  }
}

/** Throw the first problem with the auth fields, the settings groups and the email secrets, for `self-host`. */
export function validateAuthConfigFields(cfg: Record<string, unknown>, filename: string): void {
  const auth = isPlainObject(cfg["auth"]) ? cfg["auth"] : {}
  const settings = {
    auth: {
      ...(auth["siteUrl"] !== undefined && { siteUrl: auth["siteUrl"] }),
      ...(auth["redirectUrls"] !== undefined && { redirectUrls: auth["redirectUrls"] }),
      ...(auth["disableSignup"] !== undefined && { disableSignup: auth["disableSignup"] }),
      ...Object.fromEntries(GROUP_KEYS.filter((key) => auth[key] !== undefined).map((key) => [key, auth[key]])),
    },
    ...(cfg["email"] !== undefined && { email: mailSubset(cfg["email"]) }),
  }
  const problems = [...validateAuthSettings(settings, "self-host"), ...unsafeProblems(auth)]
  const [first] = problems
  if (first !== undefined) throw new Error(`${filename}: ${first}`)
  warnLiteralSecrets(settings.email)
}

/** The email secrets a self-host config may still hold as a literal, for now. */
const LITERAL_SECRETS = [
  { path: "email.smtp.pass", field: "pass", read: (email: Record<string, unknown>) => (isPlainObject(email["smtp"]) ? email["smtp"]["pass"] : undefined) },
  { path: "email.resend_api_key", field: "resend_api_key", read: (email: Record<string, unknown>) => email["resend_api_key"] },
] as const

/** Warned once each: a command reads the config more than once. */
const warnedLiterals = new Set<string>()

/**
 * Supatype Cloud refuses a literal secret in config, and self-host accepts one for now so existing
 * configs keep working. Say that the next release refuses it too, and how to change it. The value
 * is never printed.
 */
function warnLiteralSecrets(email: Record<string, unknown> | undefined): void {
  if (email === undefined) return
  for (const secret of LITERAL_SECRETS) {
    const value = secret.read(email)
    if (typeof value !== "string" || value.trim() === "" || value.trim().startsWith("env(")) continue
    if (warnedLiterals.has(secret.path)) continue
    warnedLiterals.add(secret.path)
    warn(
      `${secret.path} holds a literal secret, which a config file committed to git should not. ` +
        `Name an environment variable instead: ${secret.field}: env("NAME"). The next release refuses a literal here, as Supatype Cloud already does.`,
    )
  }
}
