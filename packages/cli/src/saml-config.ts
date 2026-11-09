/**
 * SAML single sign-on from `auth.sso.saml` in supatype.config.ts.
 *
 * The auth server has a full SAML service provider, switched on by `SUPATYPE_SAML_*` variables that
 * nothing used to set. This module turns the config section into those variables for the compose
 * stack and for native dev, and keeps the service provider's signing key in `.env`.
 *
 * The key is a secret, so it is never in the config or the compose file: compose names the variable
 * and requires it, as it does the control plane secret. It is generated once and never replaced,
 * because every identity provider that trusts the SP's certificate stops trusting it when the key
 * changes. Rotation is a second key beside it (`supatype sso rotate-key`).
 *
 * Precedence is the same as `auth.providers`: a `SUPATYPE_SAML_*` value in `.env` wins over the config.
 */
import { generateKeyPairSync } from "node:crypto"
import { isPlainObject, UNSAFE_LITERAL, validateHttpUrl } from "./auth-providers.js"
import { hasEnvValue, readEnvFile, upsertEnvFile } from "./env-file.js"
import type { SupatypeProjectConfig } from "./project-config.js"

/** `auth.sso.saml`: the switch for the server's SAML service provider and its settings. */
export interface AuthSamlConfig {
  /** Turns SAML on. The signing key is generated into `.env` the first time it is true. */
  enabled: boolean
  /** Accept encrypted assertions, and advertise the key for encryption in the SP metadata. */
  allowEncryptedAssertions?: boolean
  /** How long an SP-initiated sign-in may take at the identity provider, in seconds. Server default 120. */
  relayStateValidity?: number
  /** Assertions the ACS accepts from one client every 5 minutes. Server default 15. */
  rateLimitAssertion?: number
  /**
   * The service provider's base URL, under which `/sso/saml/metadata` and `/sso/saml/acs` are
   * served. Default: the public API URL plus `/auth/v1`, where the gateway serves the auth routes.
   */
  externalUrl?: string
}

/** `auth.sso`: single sign-on with enterprise identity providers. */
export interface AuthSsoConfig {
  saml?: AuthSamlConfig
}

/** The variable holding the service provider's signing key: standard base64 of PKCS#1 DER. */
export const SAML_PRIVATE_KEY_ENV = "SUPATYPE_SAML_PRIVATE_KEY"

/** The key that replaces it at the next rotation, published beside it while IdPs switch over. */
export const SAML_NEXT_PRIVATE_KEY_ENV = "SUPATYPE_SAML_NEXT_PRIVATE_KEY"

/** Where the gateway serves the auth server's routes, under the public API URL. */
export const AUTH_ROUTES_PATH = "/auth/v1"

/** Whether the project turned SAML on. */
export function samlEnabled(config: SupatypeProjectConfig): boolean {
  return config.auth?.sso?.saml?.enabled === true
}

/**
 * A new signing key, as the server reads it: RSA 2048 with exponent 65537, PKCS#1 DER, standard
 * base64 (`internal/conf/saml.go`).
 */
export function generateSamlPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: "pkcs1", format: "der" },
    publicKeyEncoding: { type: "pkcs1", format: "der" },
  })
  return privateKey.toString("base64")
}

/**
 * Generate the signing key into `.env` when SAML is on and the project has none. Written once and
 * then left alone, whatever it holds. Returns whether it wrote one. The value is never printed.
 */
export function ensureSamlPrivateKey(cwd: string, config: SupatypeProjectConfig): boolean {
  if (!samlEnabled(config) || hasEnvValue(cwd, SAML_PRIVATE_KEY_ENV)) return false
  upsertEnvFile(cwd, { [SAML_PRIVATE_KEY_ENV]: generateSamlPrivateKey() })
  return true
}

/** `auth.sso.saml` when SAML is on. */
function enabledSaml(config: SupatypeProjectConfig): AuthSamlConfig | undefined {
  const saml = config.auth?.sso?.saml
  return saml?.enabled === true ? saml : undefined
}

/** The settings `auth.sso.saml` states, as the variables the server reads. Not the key. */
function samlSettings(saml: AuthSamlConfig): Record<string, string> {
  return {
    SUPATYPE_SAML_ENABLED: "true",
    ...(saml.allowEncryptedAssertions !== undefined && {
      SUPATYPE_SAML_ALLOW_ENCRYPTED_ASSERTIONS: String(saml.allowEncryptedAssertions),
    }),
    ...(saml.relayStateValidity !== undefined && {
      SUPATYPE_SAML_RELAY_STATE_VALIDITY_PERIOD: `${saml.relayStateValidity}s`,
    }),
    ...(saml.rateLimitAssertion !== undefined && { SUPATYPE_SAML_RATE_LIMIT_ASSERTION: String(saml.rateLimitAssertion) }),
  }
}

/**
 * The server service's `environment:` lines for SAML, for the compose file. Nothing while SAML is
 * off. `publicApiUrl` is the compose expression for the gateway's public URL.
 */
export function composeSamlEnv(config: SupatypeProjectConfig, publicApiUrl: string): string {
  const saml = enabledSaml(config)
  if (saml === undefined) return ""
  const externalUrl = saml.externalUrl?.trim() ?? `${publicApiUrl}${AUTH_ROUTES_PATH}`
  const settings = { ...samlSettings(saml), SUPATYPE_SAML_EXTERNAL_URL: externalUrl }
  const lines = Object.entries(settings).map(([key, value]) => `      ${key}: "\${${key}:-${value}}"\n`)
  return (
    "      # auth.sso.saml from supatype.config.ts. A value in .env wins over each default. The signing\n" +
    "      # key is required from .env and never written here; the next key is set during a rotation.\n" +
    lines.join("") +
    `      ${SAML_PRIVATE_KEY_ENV}: "\${${SAML_PRIVATE_KEY_ENV}:?${SAML_PRIVATE_KEY_ENV} is missing from .env}"\n` +
    `      ${SAML_NEXT_PRIVATE_KEY_ENV}: "\${${SAML_NEXT_PRIVATE_KEY_ENV}:-}"\n`
  )
}

/**
 * SAML as the native dev server's environment, the key generated into `.env` first when it has none.
 * Nothing while SAML is off. Spread before `.env`, so a `SUPATYPE_SAML_*` value there still wins.
 * The external URL is left to the server unless stated: natively its API URL already ends in `/auth/v1`.
 */
export function nativeSamlEnv(cwd: string, config: SupatypeProjectConfig): Record<string, string> {
  const saml = enabledSaml(config)
  if (saml === undefined) return {}
  ensureSamlPrivateKey(cwd, config)
  const env = readEnvFile(cwd)
  const externalUrl = saml.externalUrl?.trim()
  return {
    ...samlSettings(saml),
    ...(externalUrl !== undefined && { SUPATYPE_SAML_EXTERNAL_URL: externalUrl }),
    ...keyEnv(env, SAML_PRIVATE_KEY_ENV),
    ...keyEnv(env, SAML_NEXT_PRIVATE_KEY_ENV),
  }
}

function keyEnv(env: Readonly<Record<string, string>>, name: string): Record<string, string> {
  const value = env[name] ?? ""
  return value === "" ? {} : { [name]: value }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SAML_FIELDS = ["enabled", "allowEncryptedAssertions", "relayStateValidity", "rateLimitAssertion", "externalUrl"]

/** Fields someone might reach for to put the key in the config, each refused with where it goes. */
const KEY_FIELDS: Readonly<Record<string, string>> = {
  privateKey: SAML_PRIVATE_KEY_ENV,
  nextPrivateKey: SAML_NEXT_PRIVATE_KEY_ENV,
}

/** `auth.sso`: only `saml`, with known fields and values that render safely. */
export function validateAuthSso(cfg: Record<string, unknown>, filename: string): void {
  const auth = cfg["auth"]
  if (!isPlainObject(auth) || auth["sso"] === undefined) return
  const sso = auth["sso"]
  if (!isPlainObject(sso)) throw new Error(`${filename}: auth.sso must be an object`)
  refuseUnknown(sso, ["saml"], "auth.sso", filename)
  const saml = sso["saml"]
  if (saml === undefined) return
  if (!isPlainObject(saml)) throw new Error(`${filename}: auth.sso.saml must be an object`)
  refuseKeyFields(saml, filename)
  refuseUnknown(saml, SAML_FIELDS, "auth.sso.saml", filename)
  validateSamlValues(saml, filename)
}

function refuseUnknown(section: Record<string, unknown>, known: readonly string[], path: string, filename: string): void {
  const unknown = Object.keys(section).filter((key) => !known.includes(key))
  if (unknown.length === 0) return
  throw new Error(`${filename}: ${path} has unknown field(s) ${unknown.join(", ")}. Known fields: ${known.join(", ")}`)
}

function refuseKeyFields(saml: Record<string, unknown>, filename: string): void {
  const field = Object.keys(KEY_FIELDS).find((key) => key in saml)
  if (field === undefined) return
  throw new Error(
    `${filename}: auth.sso.saml.${field} cannot be set in the config: the signing key is a secret, and the ` +
      `config is committed. It is ${KEY_FIELDS[field]} in .env, which the CLI generates when SAML is turned on.`,
  )
}

function validateSamlValues(saml: Record<string, unknown>, filename: string): void {
  for (const field of ["enabled", "allowEncryptedAssertions"]) {
    const value = saml[field]
    if ((field === "enabled" || value !== undefined) && typeof value !== "boolean") {
      throw new Error(`${filename}: auth.sso.saml.${field} must be true or false`)
    }
  }
  const validity = saml["relayStateValidity"]
  if (validity !== undefined && !(Number.isInteger(validity) && typeof validity === "number" && validity > 0)) {
    throw new Error(`${filename}: auth.sso.saml.relayStateValidity must be a whole number of seconds above 0`)
  }
  const rate = saml["rateLimitAssertion"]
  if (rate !== undefined && !(typeof rate === "number" && Number.isFinite(rate) && rate > 0)) {
    throw new Error(`${filename}: auth.sso.saml.rateLimitAssertion must be a number above 0 (assertions per 5 minutes)`)
  }
  validateExternalUrl(saml["externalUrl"], filename)
}

function validateExternalUrl(value: unknown, filename: string): void {
  if (value === undefined) return
  const path = "auth.sso.saml.externalUrl"
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${filename}: ${path} must be a non-empty string`)
  if (UNSAFE_LITERAL.test(value)) {
    throw new Error(`${filename}: ${path} cannot contain $, braces, quotes, backslashes or control characters`)
  }
  validateHttpUrl(value, path, filename)
}
