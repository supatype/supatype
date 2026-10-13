/**
 * OAuth providers from `auth.providers` in supatype.config.ts.
 *
 * The auth server reads each provider from `SUPATYPE_EXTERNAL_<PROVIDER>_*` variables, which used to
 * be the only way to configure one: by hand, in `.env`, and with nothing to say that the redirect URI
 * the server insists on has to be `<public API URL>/auth/v1/callback` behind the gateway. This module
 * turns the config section into those variables for the compose stack and for native dev.
 *
 * Precedence: a `SUPATYPE_EXTERNAL_*` value already in `.env` (or the shell) wins over the config, as
 * `.env` wins over config everywhere else the two overlap (`${KEY:-default}` in the compose file,
 * `.env` spread last in native dev). Projects configured through `.env` alone keep working unchanged.
 */
import type { SupatypeProjectConfig } from "./project-config.js"

/**
 * Every OAuth provider the auth server has (its `ProviderConfiguration`), by the name
 * `/auth/v1/authorize?provider=` takes. The env name is the same, upper-cased.
 */
export const AUTH_PROVIDERS = [
  "apple",
  "azure",
  "bitbucket",
  "discord",
  "facebook",
  "figma",
  "fly",
  "github",
  "gitlab",
  "google",
  "kakao",
  "keycloak",
  "linkedin",
  "linkedin_oidc",
  "notion",
  "slack",
  "slack_oidc",
  "snapchat",
  "spotify",
  "twitch",
  "twitter",
  "vercel_marketplace",
  "workos",
  "x",
  "zoom",
] as const

export type AuthProviderName = (typeof AUTH_PROVIDERS)[number]

/**
 * A value read from the environment when the stack starts, never stored in the config.
 *
 * The same `env(NAME)` spelling Supabase's config.toml uses. Write it with `env("NAME")` from
 * `@supatype/cli`.
 */
export type EnvReference = `env(${string})`

export interface AuthProviderConfig {
  /** Default true: listing a provider is asking for it. False keeps the settings and turns it off. */
  enabled?: boolean
  /** The OAuth app's client id. Not a secret, so a literal is fine; `env("NAME")` works too. */
  clientId?: string
  /**
   * The OAuth app's client secret, as `env("NAME")` only: the config is committed, and the compose
   * file names the variable rather than holding the value. Omitted, the server reads
   * `SUPATYPE_EXTERNAL_<PROVIDER>_SECRET` from `.env`.
   */
  secret?: EnvReference
  /**
   * Where the provider sends the browser back. Default `<public API URL>/auth/v1/callback`, the auth
   * server's callback as the gateway exposes it. Register the same URL with the provider.
   */
  redirectUri?: string
  /** The provider's base URL, for self-hosted ones: GitHub Enterprise, GitLab, Keycloak, WorkOS. */
  url?: string
  /** Skip the OIDC nonce check (Apple and Google sign-in from native apps). */
  skipNonceCheck?: boolean
  /** Accept a user the provider returns without an email address. */
  emailOptional?: boolean
}

export type AuthProvidersConfig = Partial<Record<AuthProviderName, AuthProviderConfig>>

/** Where the auth server's callback is, under the API's public URL. */
export const AUTH_CALLBACK_PATH = "/auth/v1/callback"

const ENV_REFERENCE = /^env\(([A-Za-z_][A-Za-z0-9_]*)\)$/

/** Build an `env(NAME)` reference. */
export function envReference(name: string): EnvReference {
  return `env(${name})`
}

/** The variable an `env(NAME)` value names, or undefined for a literal. */
export function envReferenceName(value: string): string | undefined {
  return ENV_REFERENCE.exec(value.trim())?.[1]
}

/** One `SUPATYPE_EXTERNAL_<PROVIDER>_<suffix>` variable, from a literal or from another variable. */
type ProviderSetting = { suffix: string; literal: string } | { suffix: string; env: string }

function stringSetting(suffix: string, value: string | undefined): ProviderSetting[] {
  if (value === undefined) return []
  const env = envReferenceName(value)
  return [env !== undefined ? { suffix, env } : { suffix, literal: value.trim() }]
}

function flagSetting(suffix: string, value: boolean | undefined): ProviderSetting[] {
  return value === undefined ? [] : [{ suffix, literal: String(value) }]
}

/** Everything a provider sets. The redirect URI defaults to the callback under `apiUrl`. */
function providerSettings(provider: AuthProviderConfig, apiUrl: string): ProviderSetting[] {
  const redirect = stringSetting("REDIRECT_URI", provider.redirectUri)
  return [
    { suffix: "ENABLED", literal: String(provider.enabled ?? true) },
    ...stringSetting("CLIENT_ID", provider.clientId),
    ...stringSetting("SECRET", provider.secret),
    ...stringSetting("URL", provider.url),
    ...flagSetting("SKIP_NONCE_CHECK", provider.skipNonceCheck),
    ...flagSetting("EMAIL_OPTIONAL", provider.emailOptional),
    ...(redirect.length > 0 ? redirect : [{ suffix: "REDIRECT_URI", literal: `${apiUrl}${AUTH_CALLBACK_PATH}` }]),
  ]
}

function envPrefix(name: string): string {
  return `SUPATYPE_EXTERNAL_${name.toUpperCase()}_`
}

/** The configured providers, in a stable order. */
function configuredProviders(config: SupatypeProjectConfig): [AuthProviderName, AuthProviderConfig][] {
  const providers = config.auth?.providers ?? {}
  return AUTH_PROVIDERS.flatMap((name) => {
    const provider = providers[name]
    return provider === undefined ? [] : [[name, provider] as [AuthProviderName, AuthProviderConfig]]
  })
}

/** Every configured provider's settings, each with the full variable name the server reads. */
function providerVariables(config: SupatypeProjectConfig, apiUrl: string): { key: string; setting: ProviderSetting }[] {
  return configuredProviders(config).flatMap(([name, provider]) =>
    providerSettings(provider, apiUrl).map((setting) => ({ key: `${envPrefix(name)}${setting.suffix}`, setting })),
  )
}

/**
 * The server service's `environment:` lines for the configured providers, for the compose file.
 *
 * Each is `${KEY:-<from config>}`, so a value in `.env` still wins. A secret is the name of the
 * variable holding it, never the value. `publicApiUrl` is the compose expression for the gateway's
 * public URL, which the default redirect URI hangs off.
 */
export function composeAuthProviderEnv(config: SupatypeProjectConfig, publicApiUrl: string): string {
  const variables = providerVariables(config, publicApiUrl)
  if (variables.length === 0) return ""
  const header =
    "      # auth.providers from supatype.config.ts. A value in .env wins over each default, and a\n" +
    "      # secret is only ever the name of the variable that holds it.\n"
  const lines = variables.map(({ key, setting }) => {
    const fallback = "env" in setting ? `\${${setting.env}:-}` : setting.literal
    return `      ${key}: "\${${key}:-${fallback}}"\n`
  })
  return header + lines.join("")
}

/**
 * The configured providers as the native dev server's environment.
 *
 * A reference is resolved from `environment` (the shell and `.env`); one that is not set is left out,
 * so `.env`'s own `SUPATYPE_EXTERNAL_*` value, spread after this, can still supply it.
 */
export function nativeAuthProviderEnv(
  config: SupatypeProjectConfig,
  serverUrl: string,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { key, setting } of providerVariables(config, serverUrl)) {
    const value = "env" in setting ? environment[setting.env] : setting.literal
    if (value !== undefined && value !== "") out[key] = value
  }
  return out
}

/**
 * One line per enabled provider whose secret is not available, for `dev` to warn about.
 *
 * The secret can come from the variable the config names or from `.env`'s own
 * `SUPATYPE_EXTERNAL_<PROVIDER>_SECRET`; with neither, sign-in with that provider fails at the server.
 */
export function missingAuthProviderSecrets(
  config: SupatypeProjectConfig,
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  const has = (key: string): boolean => (environment[key] ?? "") !== ""
  return configuredProviders(config).flatMap(([name, provider]) => {
    if (provider.enabled === false || has(`${envPrefix(name)}SECRET`)) return []
    const named = provider.secret !== undefined ? envReferenceName(provider.secret) : undefined
    if (named !== undefined && has(named)) return []
    const where = named !== undefined ? `${named} (auth.providers.${name}.secret)` : `${envPrefix(name)}SECRET`
    return [`auth.providers.${name}: ${where} is not set in .env or the environment, so sign-in with ${name} will fail`]
  })
}

/** Print {@link missingAuthProviderSecrets}, once per `dev` start. */
export function warnMissingAuthProviderSecrets(
  config: SupatypeProjectConfig,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  for (const line of missingAuthProviderSecrets(config, environment)) console.warn(`[supatype] ${line}`)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const STRING_FIELDS = ["clientId", "redirectUri", "url"] as const
const FLAG_FIELDS = ["enabled", "skipNonceCheck", "emailOptional"] as const
const KNOWN_FIELDS = new Set<string>([...STRING_FIELDS, ...FLAG_FIELDS, "secret"])

/**
 * Characters a literal may not carry: each value is written inside `"${KEY:-...}"` in the compose
 * file, where `$`, braces, a quote or a backslash would end the expression or the YAML string early.
 */
const UNSAFE_LITERAL = /[$"{}\\\u0000-\u001f\u007f]/

/** `auth.providers`: known provider names, known fields, and values that render safely. */
export function validateAuthProviders(cfg: Record<string, unknown>, filename: string): void {
  const auth = cfg["auth"]
  if (auth === undefined) return
  if (!isPlainObject(auth)) throw new Error(`${filename}: auth must be an object`)
  const providers = auth["providers"]
  if (providers === undefined) return
  if (!isPlainObject(providers)) throw new Error(`${filename}: auth.providers must be an object keyed by provider`)

  const known = new Set<string>(AUTH_PROVIDERS)
  for (const [name, provider] of Object.entries(providers)) {
    if (!known.has(name)) {
      throw new Error(
        `${filename}: auth.providers.${name} is not a provider the auth server has. ` +
          `Use one of: ${AUTH_PROVIDERS.join(", ")}`,
      )
    }
    validateProvider(provider, `auth.providers.${name}`, filename)
  }
}

function validateProvider(provider: unknown, path: string, filename: string): void {
  if (!isPlainObject(provider)) throw new Error(`${filename}: ${path} must be an object`)
  const unknown = Object.keys(provider).filter((key) => !KNOWN_FIELDS.has(key))
  if (unknown.length > 0) {
    throw new Error(
      `${filename}: ${path} has unknown field(s) ${unknown.join(", ")}. ` +
        `Known fields: ${[...KNOWN_FIELDS].join(", ")}`,
    )
  }
  for (const field of FLAG_FIELDS) {
    const value = provider[field]
    if (value !== undefined && typeof value !== "boolean") throw new Error(`${filename}: ${path}.${field} must be true or false`)
  }
  for (const field of STRING_FIELDS) validateStringField(provider[field], `${path}.${field}`, filename)
  validateSecret(provider["secret"], `${path}.secret`, filename)
}

function validateStringField(value: unknown, path: string, filename: string): void {
  if (value === undefined) return
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${filename}: ${path} must be a non-empty string`)
  if (value.trim().startsWith("env(")) {
    validateEnvReference(value, path, filename)
    return
  }
  if (UNSAFE_LITERAL.test(value)) {
    throw new Error(
      `${filename}: ${path} cannot contain $, braces, quotes, backslashes or control characters ` +
        `(got ${JSON.stringify(value)}). Put an unusual value in .env and reference it with env("NAME").`,
    )
  }
  if (path.endsWith(".url") || path.endsWith(".redirectUri")) validateHttpUrl(value, path, filename)
}

function validateSecret(value: unknown, path: string, filename: string): void {
  if (value === undefined) return
  if (typeof value === "string" && value.trim().startsWith("env(")) {
    validateEnvReference(value, path, filename)
    return
  }
  throw new Error(
    `${filename}: ${path} must name an environment variable, not hold the secret: ` +
      `secret: env("GITHUB_SECRET"), with GITHUB_SECRET in .env. ` +
      "The config is committed, and the compose file is written from it.",
  )
}

function validateEnvReference(value: string, path: string, filename: string): void {
  if (envReferenceName(value) !== undefined) return
  throw new Error(
    `${filename}: ${path} ${JSON.stringify(value)} is not a valid env("NAME") reference: ` +
      "NAME must be a variable name (letters, digits and underscores, not starting with a digit)",
  )
}

function validateHttpUrl(value: string, path: string, filename: string): void {
  let protocol: string
  try {
    protocol = new URL(value.trim()).protocol
  } catch {
    throw new Error(`${filename}: ${path} must be an absolute http(s) URL (got ${JSON.stringify(value)})`)
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`${filename}: ${path} must be an http or https URL (got ${JSON.stringify(value)})`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
