/**
 * The `auth.siteUrl`, `auth.redirectUrls`, `auth.disableSignup` and email secret rules, checked with
 * the shared rules in `@supatype/types` so the CLI and the Cloud control plane agree on them.
 *
 * Only the fields this covers are handed over: `auth.providers` keeps its own checks
 * (`validateAuthProviders`), and the rest of `email` was never validated, so a config that worked
 * before still loads.
 */
import { validateAuthSettings } from "@supatype/types"
import { UNSAFE_LITERAL, isPlainObject } from "./auth-providers.js"

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

/** The part of `email` the shared rules check here: the provider and the two secrets. */
function mailSubset(email: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(email)) return undefined
  const smtp = isPlainObject(email["smtp"]) ? email["smtp"] : undefined
  return {
    ...(email["provider"] !== undefined && { provider: email["provider"] }),
    ...(email["resend_api_key"] !== undefined && { resend_api_key: email["resend_api_key"] }),
    ...(smtp?.["pass"] !== undefined && { smtp: { pass: smtp["pass"] } }),
  }
}

/** Throw the first problem with the new auth fields and the email secrets, for `self-host`. */
export function validateAuthConfigFields(cfg: Record<string, unknown>, filename: string): void {
  const auth = isPlainObject(cfg["auth"]) ? cfg["auth"] : {}
  const settings = {
    auth: {
      ...(auth["siteUrl"] !== undefined && { siteUrl: auth["siteUrl"] }),
      ...(auth["redirectUrls"] !== undefined && { redirectUrls: auth["redirectUrls"] }),
      ...(auth["disableSignup"] !== undefined && { disableSignup: auth["disableSignup"] }),
    },
    ...(cfg["email"] !== undefined && { email: mailSubset(cfg["email"]) }),
  }
  const problems = [...validateAuthSettings(settings, "self-host"), ...unsafeProblems(auth)]
  const [first] = problems
  if (first !== undefined) throw new Error(`${filename}: ${first}`)
}
