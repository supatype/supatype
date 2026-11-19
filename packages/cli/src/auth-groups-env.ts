/**
 * The auth settings groups (hooks, captcha, password, sessions, security, MFA, anonymous sign-in,
 * phone, rate limits) from `supatype.config.ts`, as the variables the auth server reads, for the
 * self-host compose file and native dev.
 *
 * What the variables are and which ones a config states comes from `groupsSelfHostVars` in
 * `@supatype/types`, so Cloud and self-host cannot disagree. Only what the config states is written:
 * a config that sets none of these renders exactly what it did before they existed. SAML is not here;
 * `saml-config.ts` owns it, because its signing key lives in `.env`.
 *
 * Precedence is the same as `auth.providers`: a value in `.env` wins over the config.
 */
import { groupsSelfHostVars, type AuthSettings } from "@supatype/types"
import type { SupatypeProjectConfig } from "./project-config.js"

/** The shared settings a config's `auth` section holds, with `sso` left out (SAML is `saml-config.ts`'s). */
function groupSettings(config: SupatypeProjectConfig): AuthSettings {
  if (config.auth === undefined) return {}
  const { sso: _sso, ...groups } = config.auth
  return { auth: groups }
}

/**
 * The server service's `environment:` lines for the settings groups, for the compose file. Each is
 * `${KEY:-<from config>}`, so a value in `.env` wins; a secret is `${KEY:-${NAME:-}}`, the name of the
 * variable that holds it and never the value. An empty string when the config sets none of them.
 */
export function composeAuthGroupsEnv(config: SupatypeProjectConfig): string {
  const vars = groupsSelfHostVars(groupSettings(config))
  if (vars.length === 0) return ""
  const lines = vars.map((setting) => {
    const fallback = "fromEnv" in setting ? `\${${setting.fromEnv}:-}` : setting.value
    return `      ${setting.key}: "\${${setting.key}:-${fallback}}"\n`
  })
  return (
    "      # auth hooks, captcha, password, session, MFA, phone and rate limit settings from\n" +
    "      # supatype.config.ts. A value in .env wins over each default, and a secret is only ever the\n" +
    "      # name of the variable that holds it.\n" +
    lines.join("")
  )
}

/**
 * The same settings as the native dev server's environment. A secret is resolved from `environment`
 * (the shell and `.env`); one that is not set is left out, so a value `.env` holds under the server's
 * own name, spread after this, can still supply it.
 */
export function nativeAuthGroupsEnv(
  config: SupatypeProjectConfig,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const setting of groupsSelfHostVars(groupSettings(config))) {
    const value = "fromEnv" in setting ? environment[setting.fromEnv] : setting.value
    if (value !== undefined && value !== "") out[setting.key] = value
  }
  return out
}
