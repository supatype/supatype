/**
 * The auth settings a project can declare, and the one renderer that turns them into the
 * `SUPATYPE_*` variables the auth server reads.
 *
 * The shape is the `auth` and `email` sections of `supatype.config.ts`, so the CLI hands its config
 * over as it is. The CLI renders it into the self-host compose file and native dev, and the Cloud
 * control plane renders it into each environment's `auth.env`. Both go through this module so a
 * setting means the same thing on both hosts.
 *
 * Pure types and pure functions: no I/O, no Node imports.
 */

import {
  GROUP_LEAF_PATHS,
  GROUP_OWNED_KEYS,
  GROUP_SECRET_KEYS,
  AUTH_HOOK_NAMES,
  groupProblems,
  groupSecretInUse,
  groupSecretRefs,
  groupsEnv,
  type AuthGroupSettings,
} from "./auth-settings-groups.js"

/** Every OAuth provider the auth server has, by the name `/auth/v1/authorize?provider=` takes. */
export const AUTH_PROVIDER_NAMES = [
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

export type AuthProviderName = (typeof AUTH_PROVIDER_NAMES)[number]

/** A value read from the deploying machine's environment, never stored in the config. */
export type EnvReference = `env(${string})`

export interface AuthProviderSettings {
  /** Default true: listing a provider is asking for it. False keeps the settings and turns it off. */
  enabled?: boolean
  clientId?: string
  /** `env("NAME")` only: the config is committed. */
  secret?: EnvReference
  /** Where the provider sends the browser back. Default: the callback under the callback base URL. */
  redirectUri?: string
  /** The provider's base URL, for self-hosted ones. */
  url?: string
  skipNonceCheck?: boolean
  emailOptional?: boolean
}

export type AuthProvidersSettings = Partial<Record<AuthProviderName, AuthProviderSettings>>

export interface AuthSmtpSettings {
  host?: string
  port?: number
  user?: string
  /** `env("NAME")`. A literal is accepted on self-host only, as it always was. */
  pass?: string
  admin_email?: string
  sender_name?: string
}

/** The `email` section of `supatype.config.ts` that the auth server's mailer reads. */
export interface AuthMailSettings {
  provider?: "console" | "smtp" | "resend" | "ses"
  smtp?: AuthSmtpSettings
  /** `env("NAME")`. A literal is accepted on self-host only. */
  resend_api_key?: string
  resend_from?: string
  ses_from?: string
  /** The project's own SES access key, `env("NAME")`. With the secret below, replaces the ambient AWS credentials. */
  ses_access_key_id?: string
  /** `env("NAME")`. */
  ses_secret_access_key?: string
  /** The SES region, e.g. `eu-west-2`. */
  ses_region?: string
}

export interface AuthSettings {
  auth?: AuthGroupSettings & {
    email?: { enabled?: boolean; enableConfirmations?: boolean }
    providers?: AuthProvidersSettings
    /** Where emailed links and OAuth land when no `redirectTo` is given. */
    siteUrl?: string
    /** Which `redirectTo` values the server accepts, as globs. */
    redirectUrls?: string[]
    /** Turn new sign-ups off. */
    disableSignup?: boolean
  }
  email?: AuthMailSettings
}

/** Which host the settings are for. Cloud is stricter about secrets. */
export type AuthTarget = "cloud" | "self-host"

/** The platform's own sender, used when the project sets no provider of its own. */
export interface PlatformMailSettings {
  host: string
  port: number
  user: string
  pass: string
  senderName: string
  adminEmail: string
}

export interface AuthRenderContext {
  /** Origin the provider callback hangs off: the environment's public API origin, no trailing slash. */
  callbackBaseUrl: string
  /** Site URL when the settings set none. */
  siteUrl: string
  /** Allow-list entries that are always present and cannot be removed, such as Studio's origin. */
  platformRedirectUrls: readonly string[]
  /** The platform sender, used when `email.provider` is unset or "console". Absent: console. */
  platformMail?: PlatformMailSettings
  /** Where the SAML service provider is served: the API's public origin plus `/auth/v1`. Absent: left to the server. */
  samlExternalUrl?: string
  /** Plain secret values by secret key ({@link AuthSecretRef.key}). A missing one renders empty. */
  secrets: Readonly<Record<string, string>>
}

export interface AuthSecretRef {
  /** `providers.<name>.secret`, `email.smtp.pass` or `email.resend_api_key`. */
  key: string
  /** The variable `env("NAME")` names on the deploying machine. */
  envName: string
}

/** Where the auth server's callback is, under the API's public URL. */
export const AUTH_CALLBACK_PATH = "/auth/v1/callback"

const ENV_REFERENCE = /^env\(([A-Za-z_][A-Za-z0-9_]*)\)$/
/** What a line of the server's .env file cannot carry. */
const UNWRITABLE = /[\u0000-\u001f\u007f']/

/** The variable an `env(NAME)` value names, or undefined for a literal. */
export function envReferenceName(value: string): string | undefined {
  return ENV_REFERENCE.exec(value.trim())?.[1]
}

const PROVIDER_STRING_SUFFIXES = ["CLIENT_ID", "SECRET", "REDIRECT_URI", "URL"] as const
const PROVIDER_FLAG_SUFFIXES = ["ENABLED", "SKIP_NONCE_CHECK", "EMAIL_OPTIONAL"] as const
const SMTP_STRING_KEYS = ["HOST", "USER", "PASS", "ADMIN_EMAIL", "SENDER_NAME"] as const

function providerPrefix(name: AuthProviderName): string {
  return `SUPATYPE_EXTERNAL_${name.toUpperCase()}_`
}

const FIXED_KEYS = [
  "SUPATYPE_EXTERNAL_EMAIL_ENABLED",
  "SUPATYPE_MAILER_AUTOCONFIRM",
  "SUPATYPE_DISABLE_SIGNUP",
  "SUPATYPE_SITE_URL",
  "SUPATYPE_URI_ALLOW_LIST",
  "SUPATYPE_MAILER_MAILER_PROVIDER",
  "SUPATYPE_SMTP_PORT",
  ...SMTP_STRING_KEYS.map((k) => `SUPATYPE_SMTP_${k}`),
  "SUPATYPE_RESEND_API_KEY",
  "SUPATYPE_RESEND_FROM",
  "SUPATYPE_SES_FROM",
  "SUPATYPE_SES_ACCESS_KEY_ID",
  "SUPATYPE_SES_SECRET_ACCESS_KEY",
  "SUPATYPE_SES_REGION",
]

/**
 * Every variable {@link authSettingsToEnv} writes, and the only ones it may. Platform-owned values
 * (the JWT secret, database URLs, `SUPATYPE_API_EXTERNAL_URL`, the mailer URL paths, JWT expiry) are
 * not here and no setting can reach them.
 */
export const AUTH_OWNED_KEYS: readonly string[] = [
  ...FIXED_KEYS,
  ...GROUP_OWNED_KEYS,
  ...AUTH_PROVIDER_NAMES.flatMap((name) => [
    ...PROVIDER_FLAG_SUFFIXES.map((s) => `${providerPrefix(name)}${s}`),
    ...PROVIDER_STRING_SUFFIXES.map((s) => `${providerPrefix(name)}${s}`),
  ]),
]

const DEFAULT_SMTP_PORT = "587"

function flag(value: boolean | undefined, fallback: boolean): string {
  return String(value ?? fallback)
}

function providerEnv(name: AuthProviderName, settings: AuthSettings, ctx: AuthRenderContext): Record<string, string> {
  const prefix = providerPrefix(name)
  const provider = settings.auth?.providers?.[name]
  const configured = provider !== undefined
  return {
    [`${prefix}ENABLED`]: flag(provider?.enabled, configured),
    [`${prefix}SKIP_NONCE_CHECK`]: flag(provider?.skipNonceCheck, false),
    [`${prefix}EMAIL_OPTIONAL`]: flag(provider?.emailOptional, false),
    [`${prefix}CLIENT_ID`]: provider?.clientId?.trim() ?? "",
    [`${prefix}SECRET`]: ctx.secrets[`providers.${name}.secret`] ?? "",
    [`${prefix}URL`]: provider?.url?.trim() ?? "",
    [`${prefix}REDIRECT_URI`]: configured
      ? (provider.redirectUri?.trim() ?? `${ctx.callbackBaseUrl}${AUTH_CALLBACK_PATH}`)
      : "",
  }
}

function emptyMailEnv(): Record<string, string> {
  return {
    SUPATYPE_MAILER_MAILER_PROVIDER: "console",
    SUPATYPE_SMTP_PORT: DEFAULT_SMTP_PORT,
    SUPATYPE_SMTP_HOST: "",
    SUPATYPE_SMTP_USER: "",
    SUPATYPE_SMTP_PASS: "",
    SUPATYPE_SMTP_ADMIN_EMAIL: "",
    SUPATYPE_SMTP_SENDER_NAME: "",
    SUPATYPE_RESEND_API_KEY: "",
    SUPATYPE_RESEND_FROM: "",
    SUPATYPE_SES_FROM: "",
    SUPATYPE_SES_ACCESS_KEY_ID: "",
    SUPATYPE_SES_SECRET_ACCESS_KEY: "",
    SUPATYPE_SES_REGION: "",
  }
}

function platformMailEnv(mail: PlatformMailSettings): Record<string, string> {
  return {
    SUPATYPE_MAILER_MAILER_PROVIDER: "smtp",
    SUPATYPE_SMTP_HOST: mail.host,
    SUPATYPE_SMTP_PORT: String(mail.port),
    SUPATYPE_SMTP_USER: mail.user,
    SUPATYPE_SMTP_PASS: mail.pass,
    SUPATYPE_SMTP_ADMIN_EMAIL: mail.adminEmail,
    SUPATYPE_SMTP_SENDER_NAME: mail.senderName,
  }
}

function projectMailEnv(mail: AuthMailSettings, ctx: AuthRenderContext): Record<string, string> {
  const smtp = mail.smtp ?? {}
  return {
    SUPATYPE_MAILER_MAILER_PROVIDER: mail.provider ?? "console",
    ...(mail.provider === "smtp" && {
      SUPATYPE_SMTP_HOST: smtp.host?.trim() ?? "",
      SUPATYPE_SMTP_PORT: String(smtp.port ?? DEFAULT_SMTP_PORT),
      SUPATYPE_SMTP_USER: smtp.user?.trim() ?? "",
      SUPATYPE_SMTP_PASS: ctx.secrets["email.smtp.pass"] ?? "",
      SUPATYPE_SMTP_ADMIN_EMAIL: smtp.admin_email?.trim() ?? "",
      SUPATYPE_SMTP_SENDER_NAME: smtp.sender_name?.trim() ?? "",
    }),
    ...(mail.provider === "resend" && {
      SUPATYPE_RESEND_API_KEY: ctx.secrets["email.resend_api_key"] ?? "",
      SUPATYPE_RESEND_FROM: mail.resend_from?.trim() ?? "",
    }),
    ...(mail.provider === "ses" && {
      SUPATYPE_SES_FROM: mail.ses_from?.trim() ?? "",
      SUPATYPE_SES_ACCESS_KEY_ID: ctx.secrets["email.ses_access_key_id"] ?? "",
      SUPATYPE_SES_SECRET_ACCESS_KEY: ctx.secrets["email.ses_secret_access_key"] ?? "",
      SUPATYPE_SES_REGION: mail.ses_region?.trim() ?? "",
    }),
  }
}

function mailEnv(settings: AuthSettings, ctx: AuthRenderContext): Record<string, string> {
  const mail = settings.email
  const ownProvider = mail?.provider !== undefined && mail.provider !== "console"
  if (!ownProvider && ctx.platformMail !== undefined) return { ...emptyMailEnv(), ...platformMailEnv(ctx.platformMail) }
  return { ...emptyMailEnv(), ...(mail !== undefined ? projectMailEnv(mail, ctx) : {}) }
}

function allowList(settings: AuthSettings, ctx: AuthRenderContext): string {
  const own = settings.auth?.redirectUrls ?? []
  return [...new Set([...own, ...ctx.platformRedirectUrls])].join(",")
}

/**
 * The settings as the auth server's environment, every owned key always present: the server's
 * reloader only ever sets variables, so a key missing from the file would keep its old value.
 * Booleans and integers are always explicit, since the server fails to parse an empty one.
 */
export function authSettingsToEnv(settings: AuthSettings, ctx: AuthRenderContext): Record<string, string> {
  const auth = settings.auth
  return {
    SUPATYPE_EXTERNAL_EMAIL_ENABLED: flag(auth?.email?.enabled, true),
    SUPATYPE_MAILER_AUTOCONFIRM: String(!(auth?.email?.enableConfirmations ?? true)),
    SUPATYPE_DISABLE_SIGNUP: flag(auth?.disableSignup, false),
    SUPATYPE_SITE_URL: auth?.siteUrl?.trim() ?? ctx.siteUrl,
    SUPATYPE_URI_ALLOW_LIST: allowList(settings, ctx),
    ...mailEnv(settings, ctx),
    ...groupsEnv(settings, ctx),
    ...Object.assign({}, ...AUTH_PROVIDER_NAMES.map((name) => providerEnv(name, settings, ctx))),
  }
}

/** The secrets the settings point at with `env("NAME")`, in a stable order. */
export function authSecretRefs(settings: AuthSettings): AuthSecretRef[] {
  const refs: AuthSecretRef[] = []
  const push = (key: string, value: string | undefined): void => {
    const envName = value === undefined ? undefined : envReferenceName(value)
    if (envName !== undefined) refs.push({ key, envName })
  }
  for (const name of AUTH_PROVIDER_NAMES) push(`providers.${name}.secret`, settings.auth?.providers?.[name]?.secret)
  push("email.smtp.pass", settings.email?.smtp?.pass)
  push("email.resend_api_key", settings.email?.resend_api_key)
  push("email.ses_access_key_id", settings.email?.ses_access_key_id)
  push("email.ses_secret_access_key", settings.email?.ses_secret_access_key)
  for (const { key, value } of groupSecretRefs(settings)) push(key, value)
  return refs
}

/**
 * Whether the settings use the secret `key`. A stored secret that nothing uses (a removed provider's,
 * a disabled CAPTCHA's) is not rendered. The platform's SAML key is in use while SAML is on.
 */
export function authSecretInUse(settings: AuthSettings, key: string): boolean {
  const grouped = groupSecretInUse(settings, key)
  if (grouped !== undefined) return grouped
  if (key === "email.smtp.pass") return settings.email?.provider === "smtp"
  if (key === "email.resend_api_key") return settings.email?.provider === "resend"
  const name = /^providers\.(.+)\.secret$/.exec(key)?.[1]
  return name !== undefined && Object.keys(settings.auth?.providers ?? {}).includes(name)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PROVIDER_FIELDS = new Set(["enabled", "clientId", "secret", "redirectUri", "url", "skipNonceCheck", "emailOptional"])
const MAIL_PROVIDERS = ["console", "smtp", "resend", "ses"]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const HTTP_URL = /^https?:\/\/[^\s/?#]+[^\s]*$/

/** Not an absolute http(s) URL. No `URL` global: this package builds without the DOM lib. */
function badUrl(value: unknown): boolean {
  return typeof value !== "string" || !HTTP_URL.test(value.trim())
}

/** Schemes a browser runs or reads as content, never allowed as a redirect target. */
const DANGEROUS_SCHEMES = ["javascript", "data", "file", "vbscript"]
const SCHEME_FORM = /^([A-Za-z][A-Za-z0-9+.-]*):[^\s,]+$/

/**
 * A redirect allow-list entry that is neither http(s) nor an app's own scheme (RFC 3986 form, such as
 * `myapp://login-callback/`). An app scheme can be claimed by another app, which the docs say.
 */
function badRedirectUrl(value: unknown): boolean {
  if (typeof value !== "string" || UNWRITABLE.test(value)) return true
  const scheme = SCHEME_FORM.exec(value.trim())?.[1]?.toLowerCase()
  if (scheme === undefined || DANGEROUS_SCHEMES.includes(scheme)) return true
  return scheme === "http" || scheme === "https" ? badUrl(value) : false
}

function stringProblem(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim() === "") return `${path} must be a non-empty string`
  if (UNWRITABLE.test(value)) return `${path} cannot contain control characters, line breaks or single quotes`
  return undefined
}

function secretProblem(value: unknown, path: string, target: AuthTarget, literalOk: boolean): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") return `${path} must be env("NAME")`
  if (value.trim().startsWith("env(")) {
    return envReferenceName(value) === undefined ? `${path} ${JSON.stringify(value)} is not a valid env("NAME") reference` : undefined
  }
  if (literalOk && target === "self-host") return undefined
  return `${path} must name an environment variable, not hold the secret: ${path.split(".").pop()}: env("NAME")`
}

function providerProblems(name: string, provider: unknown): string[] {
  const path = `auth.providers.${name}`
  if (!(AUTH_PROVIDER_NAMES as readonly string[]).includes(name)) {
    return [`${path} is not a provider the auth server has. Use one of: ${AUTH_PROVIDER_NAMES.join(", ")}`]
  }
  if (!isObject(provider)) return [`${path} must be an object`]
  const unknown = Object.keys(provider).filter((k) => !PROVIDER_FIELDS.has(k))
  const found = [
    ...(unknown.length > 0 ? [`${path} has unknown field(s) ${unknown.join(", ")}`] : []),
    ...(["clientId", "redirectUri", "url"] as const).map((f) => stringProblem(provider[f], `${path}.${f}`)),
    ...(["redirectUri", "url"] as const).map((f) =>
      provider[f] !== undefined && badUrl(provider[f]) ? `${path}.${f} must be an absolute http(s) URL` : undefined,
    ),
    ...(["enabled", "skipNonceCheck", "emailOptional"] as const).map((f) =>
      provider[f] !== undefined && typeof provider[f] !== "boolean" ? `${path}.${f} must be true or false` : undefined,
    ),
    secretProblem(provider["secret"], `${path}.secret`, "self-host", false),
  ]
  return found.filter((p): p is string => p !== undefined)
}

function authProblems(auth: unknown, target: AuthTarget): string[] {
  if (auth === undefined) return []
  if (!isObject(auth)) return ["auth must be an object"]
  const problems: string[] = []
  const providers = auth["providers"]
  if (providers !== undefined && !isObject(providers)) problems.push("auth.providers must be an object keyed by provider")
  if (isObject(providers)) {
    for (const [name, provider] of Object.entries(providers)) problems.push(...providerProblems(name, provider))
  }
  if (auth["siteUrl"] !== undefined && badUrl(auth["siteUrl"])) problems.push("auth.siteUrl must be an absolute http(s) URL")
  const urls = auth["redirectUrls"]
  if (urls !== undefined && (!Array.isArray(urls) || urls.some(badRedirectUrl))) {
    problems.push(
      "auth.redirectUrls must be a list of http(s) URLs or app scheme URLs such as myapp://callback (globs allowed; javascript:, data:, file: and vbscript: are refused)",
    )
  }
  if (auth["disableSignup"] !== undefined && typeof auth["disableSignup"] !== "boolean") {
    problems.push("auth.disableSignup must be true or false")
  }
  return [...problems, ...groupProblems(auth, target)]
}

function smtpProblems(smtp: unknown, target: AuthTarget): string[] {
  if (smtp === undefined) return []
  if (!isObject(smtp)) return ["email.smtp must be an object"]
  const found = [
    ...(["host", "user", "admin_email", "sender_name"] as const).map((f) => stringProblem(smtp[f], `email.smtp.${f}`)),
    smtp["port"] !== undefined && !Number.isInteger(smtp["port"]) ? "email.smtp.port must be an integer" : undefined,
    secretProblem(smtp["pass"], "email.smtp.pass", target, true),
  ]
  return found.filter((p): p is string => p !== undefined)
}

function mailProblems(email: unknown, target: AuthTarget): string[] {
  if (email === undefined) return []
  if (!isObject(email)) return ["email must be an object"]
  const provider = email["provider"]
  const found = [
    provider !== undefined && !MAIL_PROVIDERS.includes(String(provider))
      ? `email.provider must be one of ${MAIL_PROVIDERS.join(", ")}`
      : undefined,
    secretProblem(email["resend_api_key"], "email.resend_api_key", target, true),
    secretProblem(email["ses_access_key_id"], "email.ses_access_key_id", target, true),
    secretProblem(email["ses_secret_access_key"], "email.ses_secret_access_key", target, true),
    ...(["resend_from", "ses_from", "ses_region"] as const).map((f) => stringProblem(email[f], `email.${f}`)),
  ]
  return [
    ...found.filter((p): p is string => p !== undefined),
    ...sesSenderProblems(provider, email["ses_from"], target),
    ...smtpProblems(email["smtp"], target),
  ]
}

/**
 * SES with no sender cannot send: the server logs "falling back to noop" and every mail is dropped
 * while the request answers 200. A self-hosted stack can take the sender from `.env`
 * (SUPATYPE_SES_FROM); a hosted project has no `.env`, so the setting is required there.
 */
function sesSenderProblems(provider: unknown, from: unknown, target: AuthTarget): string[] {
  if (target !== "cloud" || provider !== "ses") return []
  if (typeof from === "string" && from.trim() !== "") return []
  return ["email.ses_from must be set when email.provider is ses: without a sender address the server sends no mail and says nothing"]
}

/**
 * Every problem with the settings, none when they are fine. Cloud refuses a literal where a secret
 * belongs (self-host kept accepting a literal SMTP password and Resend key, so it still does).
 * Whether a secret a choice needs is present is not judged here: {@link groupRequiredSecretKeys} names
 * what each choice needs, and the caller checks it against what it holds (the control plane against
 * its held secrets, the CLI push against the references in the config).
 */
export function validateAuthSettings(settings: unknown, target: AuthTarget): string[] {
  if (!isObject(settings)) return ["settings must be an object"]
  return [...authProblems(settings["auth"], target), ...mailProblems(settings["email"], target)]
}

// ---------------------------------------------------------------------------
// The file the server's reloader reads
// ---------------------------------------------------------------------------

function quoteEnvValue(key: string, value: string): string {
  if (UNWRITABLE.test(value)) throw new Error(`${key} cannot be written: it holds a control character, line break or single quote`)
  return `'${value}'`
}

/**
 * `KEY='value'` lines in a stable order, for the auth server's `--config-dir` (a `.env` file).
 * Single quotes mean no expansion. A value holding a single quote is refused: the server's .env parser
 * (godotenv 1.5.1) mis-reads the double-quoted alternatives, as checked against the real parser.
 */
export function renderEnvFile(env: Readonly<Record<string, string>>): string {
  return (
    Object.keys(env)
      .sort()
      .map((key) => `${key}=${quoteEnvValue(key, env[key] ?? "")}\n`)
      .join("")
  )
}

// ---------------------------------------------------------------------------
// One leaf per setting: how the layers (default, code, Studio) are compared and merged
// ---------------------------------------------------------------------------

/** One setting's value. Arrays stand for a whole list (the redirect allow list). */
export type AuthSettingValue = string | number | boolean | string[]

/** Settings as `{ "auth.providers.github.clientId": "..." }`, secrets left out. */
export type FlatAuthSettings = Record<string, AuthSettingValue>

const PROVIDER_LEAF_FIELDS = ["clientId", "redirectUri", "url", "skipNonceCheck", "emailOptional"] as const
const SMTP_LEAF_FIELDS = ["host", "port", "user", "admin_email", "sender_name"] as const

const GLOBAL_LEAF_PATHS = [
  "auth.siteUrl",
  "auth.redirectUrls",
  "auth.disableSignup",
  "auth.email.enabled",
  "auth.email.enableConfirmations",
  "email.provider",
  "email.resend_from",
  "email.ses_from",
  "email.ses_region",
  ...SMTP_LEAF_FIELDS.map((f) => `email.smtp.${f}`),
  ...GROUP_LEAF_PATHS,
]

const PROVIDER_LEAF_PATHS = AUTH_PROVIDER_NAMES.flatMap((name) =>
  ["enabled", ...PROVIDER_LEAF_FIELDS].map((f) => `auth.providers.${name}.${f}`),
)

const LEAF_PATHS: ReadonlySet<string> = new Set([...GLOBAL_LEAF_PATHS, ...PROVIDER_LEAF_PATHS])

/** The secret keys: each provider's secret, the SMTP password, the Resend key, hook, CAPTCHA and SMS secrets. */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  ...AUTH_PROVIDER_NAMES.map((name) => `providers.${name}.secret`),
  "email.smtp.pass",
  "email.resend_api_key",
  "email.ses_access_key_id",
  "email.ses_secret_access_key",
  ...GROUP_SECRET_KEYS,
])

/** Whether `path` is a setting that can be saved: not a secret, not a platform-owned value. */
export function isAuthSettingPath(path: string): boolean {
  return LEAF_PATHS.has(path)
}

/** Whether `key` names a secret ({@link AuthSecretRef.key}). */
export function isAuthSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key)
}

/** Every path {@link isAuthSettingPath} accepts, for a view that lists each setting. */
export function authSettingPaths(): string[] {
  return [...LEAF_PATHS]
}

/** Every secret key, for a view that lists each as set or not set. */
export function authSecretKeys(): string[] {
  return [...SECRET_KEYS]
}

function walk(node: unknown, path: string[], out: FlatAuthSettings): void {
  const key = path.join(".")
  if (LEAF_PATHS.has(key)) {
    if (node !== undefined) out[key] = node as AuthSettingValue
    return
  }
  if (!isObject(node)) return
  for (const [name, child] of Object.entries(node)) walk(child, [...path, name], out)
}

/**
 * The settings as one leaf per setting. A provider that is listed always gets an explicit `enabled`
 * (true unless it says otherwise), so enabling or disabling it is a leaf that a layer can set or
 * mask. Secret references are not leaves: secrets are stored apart, by {@link AuthSecretRef.key}.
 */
export function flattenAuthSettings(settings: AuthSettings): FlatAuthSettings {
  const out: FlatAuthSettings = {}
  walk(settings, [], out)
  for (const name of AUTH_PROVIDER_NAMES) {
    const provider = settings.auth?.providers?.[name]
    if (provider !== undefined) out[`auth.providers.${name}.enabled`] = provider.enabled ?? true
  }
  for (const name of AUTH_HOOK_NAMES) {
    const hook = settings.auth?.hooks?.[name]
    if (hook !== undefined) out[`auth.hooks.${name}.enabled`] = hook.enabled ?? true
  }
  return out
}

/** The inverse of {@link flattenAuthSettings}. Paths that are not settings are ignored. */
export function unflattenAuthSettings(flat: Readonly<FlatAuthSettings>): AuthSettings {
  const root: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(flat)) {
    if (!LEAF_PATHS.has(path)) continue
    const parts = path.split(".")
    const last = parts.pop() as string
    let node = root
    for (const part of parts) {
      const next = node[part]
      node = isObject(next) ? next : (node[part] = {})
    }
    node[last] = value
  }
  return root as AuthSettings
}

/** The settings narrowed to {@link AuthSettings} when they pass {@link validateAuthSettings}, else the problems. */
export function parseAuthSettings(
  raw: unknown,
  target: AuthTarget,
): { ok: true; settings: AuthSettings } | { ok: false; problems: string[] } {
  const problems = validateAuthSettings(raw, target)
  // Validation has checked every field this type has, so the shape is known to hold.
  return problems.length === 0 ? { ok: true, settings: raw as AuthSettings } : { ok: false, problems }
}
