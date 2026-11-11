import { NOT_OAUTH, normaliseAuthSettings, type AuthSettings } from "../hooks/useAuthSettings.js"
import { studioGatewayHeaders } from "./studio-gateway-headers.js"

/** How a provider's name is written where it is not just capitalised. */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  github: "GitHub",
  gitlab: "GitLab",
  linkedin: "LinkedIn",
  linkedin_oidc: "LinkedIn",
  slack_oidc: "Slack",
  workos: "WorkOS",
}

/** The provider's name as a person reads it: `keycloak` is Keycloak, `github` is GitHub. */
export function providerLabel(name: string): string {
  const known = PROVIDER_LABELS[name]
  if (known !== undefined) return known
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ")
}

/**
 * The providers Studio's sign-in offers: every OAuth provider the auth server reports enabled, in
 * name order, narrowed to `narrowedTo` (`studio.auth.providers`) when the project sets it. A name
 * in `narrowedTo` that the server has off is not offered: it could only fail.
 */
export function studioSignInProviders(settings: AuthSettings, narrowedTo: readonly string[] | undefined): string[] {
  const allowed = narrowedTo === undefined ? null : new Set(narrowedTo.map((name) => name.toLowerCase()))
  return Object.entries(settings.external)
    .filter(([name, on]) => on && !NOT_OAUTH.has(name) && (allowed === null || allowed.has(name)))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b))
}

/** The ways Studio's sign-in page offers, from what the auth server reports. */
export interface StudioSignInMethods {
  /** OAuth providers, by the name `/authorize` takes (see `studioSignInProviders`). */
  providers: string[]
  /** Email and password. Off when the project turns email sign-in off, since it could only fail. */
  password: boolean
  /** SAML single sign-on, found by the work email's domain. */
  sso: boolean
}

/** What a page offers before the settings arrive, or when they cannot be read: email and password. */
export const PASSWORD_ONLY: StudioSignInMethods = { providers: [], password: true, sso: false }

/**
 * 0.9.2 release test (N-FF3): an SSO-only project turns email sign-in off, and the first SSO link
 * removes an account's password, so Studio offers SAML whenever the server has it on, and drops the
 * password form when email sign-in is off.
 */
export function studioSignInMethods(settings: AuthSettings, narrowedTo: readonly string[] | undefined): StudioSignInMethods {
  return {
    providers: studioSignInProviders(settings, narrowedTo),
    password: settings.external["email"] !== false,
    sso: settings.saml_enabled,
  }
}

/** The auth server's public settings, read before anybody has signed in. */
export async function fetchSignInSettings(apiBaseUrl: string, anonKey: string): Promise<AuthSettings> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/auth/v1/settings`, {
    headers: { apikey: anonKey, ...studioGatewayHeaders() },
  })
  if (!res.ok) throw new Error(`Could not read the auth settings (${res.status})`)
  return normaliseAuthSettings(await res.json())
}
