/**
 * `studio.auth.providers` in supatype.config.ts: which of the project's OAuth providers Studio's
 * sign-in page offers.
 *
 * Unset, Studio offers every provider the auth server reports enabled. Set, it offers only those
 * named (and still only the enabled ones). Signing in is not access: Studio still requires a Studio
 * role, however the person signed in.
 *
 * Studio reads the list before anybody has signed in, so it travels the way Studio's API URL and
 * anon key do: in `SUPATYPE_CLOUD_JSON`, which the Studio container writes into the page as
 * `window.__SUPATYPE_CLOUD__` when it starts.
 */
import { AUTH_PROVIDERS } from "./auth-providers.js"
import { objectAt } from "./ast-read.js"

/** A `custom:` provider's identifier, as the auth server accepts it; nothing that needs quoting. */
const CUSTOM_PROVIDER = /^custom:[a-z0-9][a-z0-9_-]*$/
const KNOWN: ReadonlySet<string> = new Set(AUTH_PROVIDERS)

function isProviderName(value: unknown): value is string {
  return typeof value === "string" && (KNOWN.has(value) || CUSTOM_PROVIDER.test(value))
}

/** Refuse a list Studio could not use: not a list, or a name the auth server has no provider for. */
export function validateStudioAuth(cfg: Record<string, unknown>, filename: string): void {
  const providers = objectAt(cfg, "studio", "auth")?.["providers"]
  if (providers === undefined) return
  if (!Array.isArray(providers)) {
    throw new Error(`${filename}: studio.auth.providers must be a list of provider names, such as ["keycloak"]`)
  }
  const bad = providers.filter((name) => !isProviderName(name))
  if (bad.length > 0) {
    throw new Error(
      `${filename}: studio.auth.providers names ${bad.map((b) => JSON.stringify(b)).join(", ")}, which is not an OAuth ` +
        `provider. Use the names auth.providers takes (${AUTH_PROVIDERS.join(", ")}) or custom:<identifier>.`,
    )
  }
}

/** The `studio` section of supatype.config.ts. */
export interface StudioConfig {
  auth?: {
    /**
     * The OAuth providers Studio's sign-in offers, by the name `auth.providers` takes (or
     * `custom:<identifier>`). Unset offers every provider the auth server has enabled. A Studio
     * role is still what lets somebody in, however they signed in.
     */
    providers?: readonly string[]
  }
}

/**
 * The `SUPATYPE_CLOUD_JSON` value for the Studio container. `url` and `anonKey` are compose
 * expressions and are left for compose to substitute; provider names never need escaping, since
 * validation admits only `[a-z0-9_:-]`.
 */
export function studioRuntimeJson(cfg: { studio?: StudioConfig }, urlExpression: string): string {
  const providers = cfg.studio?.auth?.providers
  const list = providers === undefined ? "" : `,"authProviders":${JSON.stringify(providers)}`
  return `{"url":"${urlExpression}","anonKey":"\${ANON_KEY:-}"${list}}`
}
