/**
 * The auth settings beyond sign-in basics: hooks, attack protection, sessions, MFA, phone sign-in,
 * anonymous sign-in, rate limits and SAML enablement.
 *
 * Each setting is one row in a table (its config path, the variable the auth server reads, its kind
 * and its value when nothing is set), and everything else is derived from the table: the leaf paths a
 * Studio layer can save, the variables the renderers own, validation, and both renderings. A new
 * setting is a new row.
 *
 * Two renderings, for two hosts:
 *   - {@link groupsEnv} writes every variable, with a default for one that is not set. Cloud reloads the
 *     file into a running server, which can set a variable but never unset it, so a removed setting
 *     has to come back as its default.
 *   - {@link groupsSelfHostVars} writes only what the config states, so a config that sets none of
 *     these renders exactly what it did before they existed.
 *
 * Pure types and pure functions: no I/O, no Node imports.
 */

import type { AuthRenderContext, AuthSettings, AuthTarget, EnvReference } from "./auth-settings.js"

// ---------------------------------------------------------------------------
// Shapes (the `auth` section of supatype.config.ts)
// ---------------------------------------------------------------------------

export const AUTH_HOOK_NAMES = [
  "customAccessToken",
  "beforeUserCreated",
  "afterUserCreated",
  "mfaVerificationAttempt",
  "passwordVerificationAttempt",
  "sendEmail",
  "sendSms",
] as const

export type AuthHookName = (typeof AUTH_HOOK_NAMES)[number]

/** The part of each hook's variable names between `SUPATYPE_HOOK_` and the suffix. */
const HOOK_ENV_SEGMENT: Readonly<Record<AuthHookName, string>> = {
  customAccessToken: "CUSTOM_ACCESS_TOKEN",
  beforeUserCreated: "BEFORE_USER_CREATED",
  afterUserCreated: "AFTER_USER_CREATED",
  mfaVerificationAttempt: "MFA_VERIFICATION_ATTEMPT",
  passwordVerificationAttempt: "PASSWORD_VERIFICATION_ATTEMPT",
  sendEmail: "SEND_EMAIL",
  sendSms: "SEND_SMS",
}

export interface AuthHookSettings {
  /** Default true: listing a hook is asking for it. False keeps the settings and turns it off. */
  enabled?: boolean
  /**
   * Where the server calls: an https URL (a project edge function's URL works), or a Postgres
   * function as `pg-functions://postgres/<schema>/<function>`.
   */
  uri?: string
  /** `env("NAME")`: the Standard Webhooks signing secret(s), `v1,whsec_...`, pipe-separated for rotation. */
  secrets?: EnvReference
}

export type AuthHooksSettings = Partial<Record<AuthHookName, AuthHookSettings>>

/** The character classes a password can be required to contain. */
export const PASSWORD_CHARACTER_CLASSES = ["lower", "upper", "digit", "symbol"] as const

export type PasswordCharacterClass = (typeof PASSWORD_CHARACTER_CLASSES)[number]

export const SMS_PROVIDERS = ["twilio", "twilio_verify", "messagebird", "textlocal", "vonage"] as const

export type SmsProviderName = (typeof SMS_PROVIDERS)[number]

export const CAPTCHA_PROVIDERS = ["hcaptcha", "turnstile"] as const

export interface AuthGroupSettings {
  hooks?: AuthHooksSettings
  /**
   * Bot protection on sign-up, sign-in and recovery. The secret is the provider's server-side key.
   * The site key is the provider's public one: the server's public settings answer hands it to Studio
   * and to apps, which render the provider's widget and send its token with the sign-in.
   */
  captcha?: { enabled?: boolean; provider?: (typeof CAPTCHA_PROVIDERS)[number]; secret?: EnvReference; siteKey?: string }
  password?: {
    /** Shortest password accepted, 6 to 72. */
    minLength?: number
    /** Classes every password must hold at least one character of. */
    requiredCharacters?: PasswordCharacterClass[]
    /** Refuse a password found in a known breach (Have I Been Pwned, by k-anonymity range). */
    leakedPasswordCheck?: boolean
  }
  /** Session lifetimes are in seconds. Unset is no limit. */
  sessions?: { timebox?: number; inactivityTimeout?: number; singlePerUser?: boolean }
  security?: {
    /** Default true: each refresh issues a new refresh token and retires the old one. */
    refreshTokenRotation?: boolean
    /** Seconds an already-used refresh token still works, for clients that retry. Default 0. */
    refreshTokenReuseInterval?: number
    updatePasswordRequireReauthentication?: boolean
    updatePasswordRequireCurrentPassword?: boolean
    /** Let a signed-in user link another identity to their account. */
    manualLinking?: boolean
  }
  mfa?: {
    /** Authenticator-app factors. Both default true. */
    totp?: { enroll?: boolean; verify?: boolean }
    /** SMS factors. Both default false; they need a phone provider. */
    phone?: { enroll?: boolean; verify?: boolean }
    maxEnrolledFactors?: number
    maxVerifiedFactors?: number
  }
  anonymous?: { enabled?: boolean }
  /** Sign-in by phone number, and the SMS provider that sends the codes. Credentials are secrets. */
  phone?: {
    enabled?: boolean
    provider?: SmsProviderName
    /** Digits in a code, 6 to 10. */
    otpLength?: number
    /** Seconds a code stays valid. */
    otpExpiry?: number
    /** Seconds before another code may be sent to the same number. */
    maxFrequency?: number
    twilio?: { accountSid?: string; authToken?: EnvReference; messageServiceSid?: string; contentSid?: string }
    twilioVerify?: { accountSid?: string; authToken?: EnvReference; messageServiceSid?: string }
    messagebird?: { accessKey?: EnvReference; originator?: string }
    textlocal?: { apiKey?: EnvReference; sender?: string }
    vonage?: { apiKey?: string; apiSecret?: EnvReference; from?: string }
  }
  /**
   * Requests one client may make in a window that depends on the limit: 5 minutes for `otp`,
   * `tokenRefresh`, `verify` and `sso`, an hour for `smsSent` and `anonymousUsers`, and a minute for
   * `mfa` (challenges and verifies together). The email limit is the platform's on Cloud and is not here.
   */
  rateLimits?: {
    otp?: number
    tokenRefresh?: number
    verify?: number
    smsSent?: number
    anonymousUsers?: number
    sso?: number
    mfa?: number
  }
  /** SAML single sign-on. The signing key is the platform's on Cloud; on self-host the CLI keeps it in `.env`. */
  sso?: {
    saml?: { enabled?: boolean; allowEncryptedAssertions?: boolean; relayStateValidity?: number; rateLimitAssertion?: number }
  }
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

type SpecKind = "flag" | "count" | "seconds" | "text" | "choice" | "list"

interface Spec {
  /** Under `auth`, as dotted keys. */
  path: string
  env: string
  kind: SpecKind
  /** What the server runs with when the setting is not set, as the variable's text. */
  fallback: string
  /**
   * What the server actually runs with when the fallback it is sent is a 0 that means "use your own
   * default". The values mirror supatype-auth internal/conf (configuration.go and saml.go), which
   * replace those zeros at load. In the setting's own unit (seconds for a duration).
   */
  effective?: string
  min?: number
  max?: number
  choices?: readonly string[]
  /** False: not rendered by the self-host path, which has its own handling (SAML). Default true. */
  selfHost?: boolean
}

/**
 * Written for an unset session lifetime. The server cannot be told "none" in a reloaded file (an empty
 * duration does not parse and zero is refused), so none is a hundred years.
 */
const NO_SESSION_LIMIT = "876000h"

const CHARACTER_SETS: Readonly<Record<PasswordCharacterClass, string>> = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digit: "0123456789",
  // No $ { } \ " ' or : here: the compose file and the server's separator cannot carry them.
  symbol: "!@#%^&*()_+-=[];<>?,./~|`",
}

const flag = (path: string, env: string, fallback: boolean): Spec => ({ path, env, kind: "flag", fallback: String(fallback) })
const count = (path: string, env: string, fallback: string, min: number, max?: number): Spec => ({
  path,
  env,
  kind: "count",
  fallback,
  min,
  ...(max !== undefined && { max }),
})
const text = (path: string, env: string): Spec => ({ path, env, kind: "text", fallback: "" })

const HOOK_SPECS: readonly Spec[] = AUTH_HOOK_NAMES.map((name) => text(`hooks.${name}.uri`, `SUPATYPE_HOOK_${HOOK_ENV_SEGMENT[name]}_URI`))

const SPECS: readonly Spec[] = [
  ...HOOK_SPECS,
  flag("captcha.enabled", "SUPATYPE_SECURITY_CAPTCHA_ENABLED", false),
  { path: "captcha.provider", env: "SUPATYPE_SECURITY_CAPTCHA_PROVIDER", kind: "choice", fallback: "hcaptcha", choices: CAPTCHA_PROVIDERS },
  text("captcha.siteKey", "SUPATYPE_SECURITY_CAPTCHA_SITE_KEY"),
  { ...count("password.minLength", "SUPATYPE_PASSWORD_MIN_LENGTH", "0", 6, 72), effective: "6" },
  { path: "password.requiredCharacters", env: "SUPATYPE_PASSWORD_REQUIRED_CHARACTERS", kind: "list", fallback: "" },
  flag("password.leakedPasswordCheck", "SUPATYPE_PASSWORD_HIBP_ENABLED", false),
  { path: "sessions.timebox", env: "SUPATYPE_SESSIONS_TIMEBOX", kind: "seconds", fallback: NO_SESSION_LIMIT, min: 60 },
  { path: "sessions.inactivityTimeout", env: "SUPATYPE_SESSIONS_INACTIVITY_TIMEOUT", kind: "seconds", fallback: NO_SESSION_LIMIT, min: 60 },
  flag("sessions.singlePerUser", "SUPATYPE_SESSIONS_SINGLE_PER_USER", false),
  flag("security.refreshTokenRotation", "SUPATYPE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED", true),
  count("security.refreshTokenReuseInterval", "SUPATYPE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL", "0", 0, 3600),
  flag("security.updatePasswordRequireReauthentication", "SUPATYPE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION", false),
  flag("security.updatePasswordRequireCurrentPassword", "SUPATYPE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD", false),
  flag("security.manualLinking", "SUPATYPE_SECURITY_MANUAL_LINKING_ENABLED", false),
  flag("mfa.totp.enroll", "SUPATYPE_MFA_TOTP_ENROLL_ENABLED", true),
  flag("mfa.totp.verify", "SUPATYPE_MFA_TOTP_VERIFY_ENABLED", true),
  flag("mfa.phone.enroll", "SUPATYPE_MFA_PHONE_ENROLL_ENABLED", false),
  flag("mfa.phone.verify", "SUPATYPE_MFA_PHONE_VERIFY_ENABLED", false),
  count("mfa.maxEnrolledFactors", "SUPATYPE_MFA_MAX_ENROLLED_FACTORS", "10", 1, 100),
  count("mfa.maxVerifiedFactors", "SUPATYPE_MFA_MAX_VERIFIED_FACTORS", "10", 1, 100),
  flag("anonymous.enabled", "SUPATYPE_EXTERNAL_ANONYMOUS_USERS_ENABLED", false),
  flag("phone.enabled", "SUPATYPE_EXTERNAL_PHONE_ENABLED", false),
  { path: "phone.provider", env: "SUPATYPE_SMS_PROVIDER", kind: "choice", fallback: "", choices: SMS_PROVIDERS },
  { ...count("phone.otpLength", "SUPATYPE_SMS_OTP_LENGTH", "0", 6, 10), effective: "6" },
  { ...count("phone.otpExpiry", "SUPATYPE_SMS_OTP_EXP", "0", 1, 86400), effective: "60" },
  { path: "phone.maxFrequency", env: "SUPATYPE_SMS_MAX_FREQUENCY", kind: "seconds", fallback: "0s", effective: "60", min: 1 },
  text("phone.twilio.accountSid", "SUPATYPE_SMS_TWILIO_ACCOUNT_SID"),
  text("phone.twilio.messageServiceSid", "SUPATYPE_SMS_TWILIO_MESSAGE_SERVICE_SID"),
  text("phone.twilio.contentSid", "SUPATYPE_SMS_TWILIO_CONTENT_SID"),
  text("phone.twilioVerify.accountSid", "SUPATYPE_SMS_TWILIO_VERIFY_ACCOUNT_SID"),
  text("phone.twilioVerify.messageServiceSid", "SUPATYPE_SMS_TWILIO_VERIFY_MESSAGE_SERVICE_SID"),
  text("phone.messagebird.originator", "SUPATYPE_SMS_MESSAGEBIRD_ORIGINATOR"),
  text("phone.textlocal.sender", "SUPATYPE_SMS_TEXTLOCAL_SENDER"),
  text("phone.vonage.apiKey", "SUPATYPE_SMS_VONAGE_API_KEY"),
  text("phone.vonage.from", "SUPATYPE_SMS_VONAGE_FROM"),
  count("rateLimits.otp", "SUPATYPE_RATE_LIMIT_OTP", "30", 1, 100000),
  count("rateLimits.tokenRefresh", "SUPATYPE_RATE_LIMIT_TOKEN_REFRESH", "150", 1, 100000),
  count("rateLimits.verify", "SUPATYPE_RATE_LIMIT_VERIFY", "30", 1, 100000),
  count("rateLimits.smsSent", "SUPATYPE_RATE_LIMIT_SMS_SENT", "30", 1, 100000),
  count("rateLimits.anonymousUsers", "SUPATYPE_RATE_LIMIT_ANONYMOUS_USERS", "30", 1, 100000),
  count("rateLimits.sso", "SUPATYPE_RATE_LIMIT_SSO", "30", 1, 100000),
  count("rateLimits.mfa", "SUPATYPE_MFA_RATE_LIMIT_CHALLENGE_AND_VERIFY", "15", 1, 100000),
  { ...flag("sso.saml.enabled", "SUPATYPE_SAML_ENABLED", false), selfHost: false },
  { ...flag("sso.saml.allowEncryptedAssertions", "SUPATYPE_SAML_ALLOW_ENCRYPTED_ASSERTIONS", false), selfHost: false },
  { path: "sso.saml.relayStateValidity", env: "SUPATYPE_SAML_RELAY_STATE_VALIDITY_PERIOD", kind: "seconds", fallback: "0s", effective: "120", min: 1, selfHost: false },
  { ...count("sso.saml.rateLimitAssertion", "SUPATYPE_SAML_RATE_LIMIT_ASSERTION", "15", 1, 100000), selfHost: false },
]

/** What a setting's default looks like to a person: a number, a switch, a choice, or null for none. */
export type GroupDefault = string | number | boolean | null

/**
 * What the server runs with for a setting nothing sets, by its saved path (`auth.rateLimits.otp`):
 * a number for a count or a duration in seconds, a boolean for a switch, the name of a choice, or
 * null when there is none (no session limit, no provider, no hook). Undefined for a path this table
 * does not hold. This is the value in force, so a fallback the server raises (a minimum length of 0
 * becomes 6) reports what it is raised to.
 */
export function groupDefault(path: string): GroupDefault | undefined {
  const spec = SPEC_BY_PATH.get(path.startsWith("auth.") ? path.slice("auth.".length) : path)
  if (spec === undefined) return undefined
  const text = spec.effective ?? spec.fallback
  switch (spec.kind) {
    case "flag":
      return text === "true"
    case "count":
      return Number(text)
    case "seconds":
      return text === NO_SESSION_LIMIT ? null : Number.parseInt(text, 10)
    case "choice":
    case "text":
    case "list":
      return text === "" ? null : text
    default: {
      const unhandled: never = spec.kind
      return unhandled
    }
  }
}

/** A setting that is a secret: the config holds `env("NAME")`, the platform holds the value. */
interface SecretSpec {
  /** The secret's key, as {@link AuthSecretRef.key} carries it. */
  key: string
  /** Under `auth`, where the `env("NAME")` sits. */
  path: string
  /**
   * The variable the group renderers write. Absent for a held secret: one the settings never state as
   * a reference under `auth` (the mail section's) and whose variable the mail renderer writes.
   */
  env?: string
  /** Whether the settings use the secret: a stored one that nothing uses is not rendered. */
  active: (settings: AuthSettings) => boolean
  /** True when the feature cannot work without it. */
  required: (settings: AuthSettings) => boolean
}

/** A secret the group renderers own: it has a variable of its own. */
type OwnedSecretSpec = SecretSpec & { env: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The value at a dotted path, or undefined. */
function at(node: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => (isObject(current) ? current[key] : undefined), node)
}

const providerIs =
  (name: SmsProviderName) =>
  (settings: AuthSettings): boolean =>
    at(settings.auth, "phone.provider") === name

const mailProviderIs =
  (name: string) =>
  (settings: AuthSettings): boolean =>
    settings.email?.provider === name

/** A mail secret the platform holds: never a stored reference, and rendered by the mail variables. */
function sesSecret(key: string): SecretSpec {
  return { key, path: key, active: mailProviderIs("ses"), required: mailProviderIs("ses") }
}

const HOOK_SECRETS: readonly SecretSpec[] = AUTH_HOOK_NAMES.map((name) => ({
  key: `hooks.${name}.secrets`,
  path: `hooks.${name}.secrets`,
  env: `SUPATYPE_HOOK_${HOOK_ENV_SEGMENT[name]}_SECRETS`,
  active: (settings) => isObject(at(settings.auth, `hooks.${name}`)),
  required: () => false,
}))

const SECRET_SPECS: readonly SecretSpec[] = [
  ...HOOK_SECRETS,
  {
    key: "captcha.secret",
    path: "captcha.secret",
    env: "SUPATYPE_SECURITY_CAPTCHA_SECRET",
    active: (settings) => at(settings.auth, "captcha.enabled") === true,
    required: (settings) => at(settings.auth, "captcha.enabled") === true,
  },
  smsSecret("phone.twilio.authToken", "SUPATYPE_SMS_TWILIO_AUTH_TOKEN", "twilio"),
  smsSecret("phone.twilioVerify.authToken", "SUPATYPE_SMS_TWILIO_VERIFY_AUTH_TOKEN", "twilio_verify"),
  smsSecret("phone.messagebird.accessKey", "SUPATYPE_SMS_MESSAGEBIRD_ACCESS_KEY", "messagebird"),
  smsSecret("phone.textlocal.apiKey", "SUPATYPE_SMS_TEXTLOCAL_API_KEY", "textlocal"),
  smsSecret("phone.vonage.apiSecret", "SUPATYPE_SMS_VONAGE_API_SECRET", "vonage"),
  sesSecret("email.ses_access_key_id"),
  sesSecret("email.ses_secret_access_key"),
]

/** The secrets with a variable of their own, which the group renderers and validation handle. */
const OWNED_SECRET_SPECS: readonly OwnedSecretSpec[] = SECRET_SPECS.filter((s): s is OwnedSecretSpec => s.env !== undefined)

function smsSecret(key: string, env: string, provider: SmsProviderName): SecretSpec {
  return { key, path: key, env, active: providerIs(provider), required: providerIs(provider) }
}

/** The key the platform generates and holds for a project's SAML service provider. Never settable or shown. */
export const SAML_PRIVATE_KEY_SECRET = "sso.saml.private_key"
const SAML_PRIVATE_KEY_ENV = "SUPATYPE_SAML_PRIVATE_KEY"
/**
 * The key a rotation moves to, held beside the current one while identity providers take its
 * certificate: the server publishes both and decrypts with either. Made and promoted by the platform,
 * never settable or shown, as the current key is.
 */
export const SAML_NEXT_PRIVATE_KEY_SECRET = "sso.saml.next_private_key"
const SAML_NEXT_PRIVATE_KEY_ENV = "SUPATYPE_SAML_NEXT_PRIVATE_KEY"
const SAML_EXTERNAL_URL_ENV = "SUPATYPE_SAML_EXTERNAL_URL"

// ---------------------------------------------------------------------------
// What the rest of the model reads from the table
// ---------------------------------------------------------------------------

/** Every variable the group renderers write. */
export const GROUP_OWNED_KEYS: readonly string[] = [
  ...SPECS.map((s) => s.env),
  ...AUTH_HOOK_NAMES.map((name) => `SUPATYPE_HOOK_${HOOK_ENV_SEGMENT[name]}_ENABLED`),
  ...OWNED_SECRET_SPECS.map((s) => s.env),
  SAML_PRIVATE_KEY_ENV,
  SAML_NEXT_PRIVATE_KEY_ENV,
  SAML_EXTERNAL_URL_ENV,
]

/**
 * The variables the server reads once, when it starts: its rate limiters are kept across a reload, so
 * a changed value reaches a running server only when it restarts.
 */
export const GROUP_RESTART_KEYS: readonly string[] = SPECS.filter(
  (s) => s.path.startsWith("rateLimits.") || s.path === "sso.saml.rateLimitAssertion",
).map((s) => s.env)

/** The paths a layer can save, as `auth.<path>`. */
export const GROUP_LEAF_PATHS: readonly string[] = [
  ...SPECS.map((s) => `auth.${s.path}`),
  ...AUTH_HOOK_NAMES.map((name) => `auth.hooks.${name}.enabled`),
]

/** Every secret key a project can set. */
export const GROUP_SECRET_KEYS: readonly string[] = SECRET_SPECS.map((s) => s.key)

/** The secrets the settings point at with `env("NAME")`: `[key, name]`. */
export function groupSecretRefs(settings: AuthSettings): { key: string; value: string | undefined }[] {
  return OWNED_SECRET_SPECS.map((s) => {
    const value = at(settings.auth, s.path)
    return { key: s.key, value: typeof value === "string" ? value : undefined }
  })
}

/** Whether the settings use the secret `key`, among the group secrets and the platform's SAML key. */
export function groupSecretInUse(settings: AuthSettings, key: string): boolean | undefined {
  if (key === SAML_PRIVATE_KEY_SECRET || key === SAML_NEXT_PRIVATE_KEY_SECRET) return at(settings.auth, "sso.saml.enabled") === true
  const spec = SECRET_SPECS.find((s) => s.key === key)
  return spec === undefined ? undefined : spec.active(settings)
}

/**
 * Secrets the settings cannot work without, by key: an enabled CAPTCHA's key, the chosen SMS
 * provider's credential, and the project's own AWS keys when SES sends the mail.
 */
export function groupRequiredSecretKeys(settings: AuthSettings): string[] {
  return SECRET_SPECS.filter((s) => s.required(settings)).map((s) => s.key)
}

/** A rule on a secret's value beyond non-empty, or undefined when it holds. Hook secrets are Standard Webhooks keys. */
export function groupSecretFormatProblem(key: string, value: string): string | undefined {
  if (!key.startsWith("hooks.")) return undefined
  const entries = value.split("|").filter((entry) => entry !== "")
  const symmetric = /^v1,whsec_[A-Za-z0-9+/=]{32,88}$/
  const asymmetric = /^v1a,whpk_[A-Za-z0-9+/=]{44,}:whsk_[A-Za-z0-9+/=]{44,}$/
  const bad = entries.length === 0 || entries.some((entry) => !symmetric.test(entry) && !asymmetric.test(entry))
  return bad ? `${key} must be v1,whsec_... (32 to 88 base64 characters), or v1a,whpk_...:whsk_..., separated by | for several` : undefined
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One setting's value as the variable's text. */
function renderValue(spec: Spec, value: unknown): string {
  if (spec.kind === "seconds") return `${String(value)}s`
  if (spec.kind === "text") return typeof value === "string" ? value.trim() : ""
  if (spec.kind === "list") {
    const classes = Array.isArray(value) ? value : []
    return PASSWORD_CHARACTER_CLASSES.filter((c) => classes.includes(c))
      .map((c) => CHARACTER_SETS[c])
      .join(":")
  }
  return String(value)
}

/** The variable's text for a spec when the settings set it, else undefined. */
function stated(auth: unknown, spec: Spec): string | undefined {
  const value = at(auth, spec.path)
  return value === undefined ? undefined : renderValue(spec, value)
}

function hookConfigured(auth: unknown, name: AuthHookName): boolean {
  return isObject(at(auth, `hooks.${name}`))
}

function hookEnabled(auth: unknown, name: AuthHookName): string {
  const enabled = at(auth, `hooks.${name}.enabled`)
  return String(typeof enabled === "boolean" ? enabled : hookConfigured(auth, name))
}

/**
 * Every group variable, explicit: a default for each setting that is not set, a secret's value from
 * `ctx.secrets` when the settings use it and empty otherwise. SAML is only on when its key is held.
 */
export function groupsEnv(settings: AuthSettings, ctx: AuthRenderContext): Record<string, string> {
  const auth = settings.auth
  const env: Record<string, string> = {}
  for (const spec of SPECS) env[spec.env] = stated(auth, spec) ?? spec.fallback
  for (const name of AUTH_HOOK_NAMES) env[`SUPATYPE_HOOK_${HOOK_ENV_SEGMENT[name]}_ENABLED`] = hookEnabled(auth, name)
  for (const secret of OWNED_SECRET_SPECS) env[secret.env] = secret.active(settings) ? (ctx.secrets[secret.key] ?? "") : ""
  const key = ctx.secrets[SAML_PRIVATE_KEY_SECRET] ?? ""
  const samlOn = at(auth, "sso.saml.enabled") === true && key !== ""
  env["SUPATYPE_SAML_ENABLED"] = String(samlOn)
  env[SAML_PRIVATE_KEY_ENV] = samlOn ? key : ""
  env[SAML_NEXT_PRIVATE_KEY_ENV] = samlOn ? (ctx.secrets[SAML_NEXT_PRIVATE_KEY_SECRET] ?? "") : ""
  env[SAML_EXTERNAL_URL_ENV] = samlOn ? (ctx.samlExternalUrl ?? "") : ""
  return env
}

/** A variable for the self-host path: a literal, or the name of the variable that holds the value. */
export type SelfHostVar = { key: string; value: string } | { key: string; fromEnv: string }

/**
 * Only what the settings state, for the self-host compose file and native dev. A secret is the name of
 * the variable holding it. SAML is left to the CLI, which keeps its signing key in `.env`.
 */
export function groupsSelfHostVars(settings: AuthSettings): SelfHostVar[] {
  const auth = settings.auth
  const out: SelfHostVar[] = []
  for (const spec of SPECS) {
    const value = spec.selfHost === false ? undefined : stated(auth, spec)
    if (value !== undefined) out.push({ key: spec.env, value })
  }
  for (const name of AUTH_HOOK_NAMES) {
    if (hookConfigured(auth, name)) out.push({ key: `SUPATYPE_HOOK_${HOOK_ENV_SEGMENT[name]}_ENABLED`, value: hookEnabled(auth, name) })
  }
  for (const secret of OWNED_SECRET_SPECS) {
    const value = at(auth, secret.path)
    const name = typeof value === "string" ? /^env\(([A-Za-z_][A-Za-z0-9_]*)\)$/.exec(value.trim())?.[1] : undefined
    if (name !== undefined) out.push({ key: secret.env, fromEnv: name })
  }
  return out
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const GROUP_KEYS = ["hooks", "captcha", "password", "sessions", "security", "mfa", "anonymous", "phone", "rateLimits", "sso"]

/** What a value written into the compose file's `"${KEY:-...}"` or an env file cannot carry. */
const UNSAFE_TEXT = /[$"'{}\\\u0000-\u001f\u007f]/

const SPEC_BY_PATH: ReadonlyMap<string, Spec> = new Map(SPECS.map((s) => [s.path, s]))
const SECRET_BY_PATH: ReadonlyMap<string, SecretSpec> = new Map(OWNED_SECRET_SPECS.map((s) => [s.path, s]))
const HOOK_ENABLED_PATHS: ReadonlySet<string> = new Set(AUTH_HOOK_NAMES.map((name) => `hooks.${name}.enabled`))

/** The names a node at `prefix` may hold, from every path in the table that starts with it. */
function allowedChildren(prefix: string): string[] {
  const all = [...SPEC_BY_PATH.keys(), ...SECRET_BY_PATH.keys(), ...HOOK_ENABLED_PATHS]
  const names = all.filter((p) => p.startsWith(`${prefix}.`)).map((p) => p.slice(prefix.length + 1).split(".")[0] ?? "")
  return [...new Set(names)]
}

function valueProblem(spec: Spec, value: unknown, path: string): string | undefined {
  switch (spec.kind) {
    case "flag":
      return typeof value === "boolean" ? undefined : `${path} must be true or false`
    case "count":
    case "seconds": {
      const unit = spec.kind === "seconds" ? "a whole number of seconds" : "a whole number"
      const low = spec.min ?? 0
      const ok = typeof value === "number" && Number.isInteger(value) && value >= low && (spec.max === undefined || value <= spec.max)
      const range = spec.max === undefined ? `${low} or more` : `${low} to ${spec.max}`
      return ok ? undefined : `${path} must be ${unit}, ${range}`
    }
    case "choice":
      return typeof value === "string" && (spec.choices ?? []).includes(value) ? undefined : `${path} must be one of ${(spec.choices ?? []).join(", ")}`
    case "list": {
      const ok = Array.isArray(value) && value.every((v) => typeof v === "string" && (PASSWORD_CHARACTER_CLASSES as readonly string[]).includes(v))
      return ok ? undefined : `${path} must be a list of ${PASSWORD_CHARACTER_CLASSES.join(", ")}`
    }
    case "text":
      if (typeof value !== "string" || value.trim() === "") return `${path} must be a non-empty string`
      return UNSAFE_TEXT.test(value) ? `${path} cannot contain $, braces, quotes, backslashes or control characters` : undefined
  }
}

function secretReferenceProblem(value: unknown, path: string): string | undefined {
  if (typeof value !== "string") return `${path} must be env("NAME")`
  if (!/^env\([A-Za-z_][A-Za-z0-9_]*\)$/.test(value.trim())) return `${path} must name an environment variable, not hold the secret: ${path.split(".").pop()}: env("NAME")`
  return undefined
}

function nodeProblems(node: unknown, prefix: string): string[] {
  const path = `auth.${prefix}`
  if (!isObject(node)) return [`${path} must be an object`]
  const known = allowedChildren(prefix)
  const unknown = Object.keys(node).filter((key) => !known.includes(key))
  const found: (string | undefined)[] = unknown.length > 0 ? [`${path} has unknown field(s) ${unknown.join(", ")}. Known fields: ${known.join(", ")}`] : []
  for (const [key, value] of Object.entries(node)) {
    if (!known.includes(key) || value === undefined) continue
    const child = `${prefix}.${key}`
    const spec = SPEC_BY_PATH.get(child)
    if (spec !== undefined) found.push(valueProblem(spec, value, `auth.${child}`))
    else if (SECRET_BY_PATH.has(child)) found.push(secretReferenceProblem(value, `auth.${child}`))
    else if (HOOK_ENABLED_PATHS.has(child)) found.push(typeof value === "boolean" ? undefined : `auth.${child} must be true or false`)
    else found.push(...nodeProblems(value, child))
  }
  return found.filter((p): p is string => p !== undefined)
}

const HTTPS_URL = /^https:\/\/[^\s/?#]+[^\s]*$/
const LOCAL_HTTP_URL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#][^\s]*)?$/
const PG_FUNCTION_URI = /^pg-functions:\/\/[^/\s]*\/[A-Za-z_][A-Za-z0-9_]*\/[A-Za-z_][A-Za-z0-9_]*$/

function hookProblems(auth: Record<string, unknown>, target: AuthTarget): string[] {
  const found: string[] = []
  for (const name of AUTH_HOOK_NAMES) {
    const hook = at(auth, `hooks.${name}`)
    if (!isObject(hook)) continue
    const uri = hook["uri"]
    const path = `auth.hooks.${name}`
    if (hook["enabled"] !== false && uri === undefined) found.push(`${path}.uri is required while the hook is enabled`)
    if (typeof uri !== "string") continue
    const local = target === "self-host" && LOCAL_HTTP_URL.test(uri.trim())
    if (!HTTPS_URL.test(uri.trim()) && !PG_FUNCTION_URI.test(uri.trim()) && !local) {
      found.push(`${path}.uri must be an https URL or pg-functions://postgres/<schema>/<function>`)
    }
  }
  return found
}

/** Every problem with the group settings; none when they are fine. */
export function groupProblems(auth: Record<string, unknown>, target: AuthTarget): string[] {
  const found = GROUP_KEYS.filter((key) => auth[key] !== undefined).flatMap((key) => nodeProblems(auth[key], key))
  return found.length > 0 ? found : hookProblems(auth, target)
}
