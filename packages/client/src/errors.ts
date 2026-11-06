import type { SupatypeErrorFields } from "./types.js"

/**
 * The Supatype SDK's one error family.
 *
 * `SupatypeError` is every error a `{ data, error }` result carries, and the root of the errors the
 * SDK throws, so `error instanceof SupatypeError` holds for all of them. `SupatypeCodedError` is the
 * thrown kind: the same fields with a required machine-readable `code` and a `helpUrl`.
 */

const DOCS_BASE = "https://docs.supatype.com/errors"

/** The fields an error carries beside its message, each kept only when it has a value. */
const ERROR_FIELDS = ["code", "status", "field", "hint", "details"] as const

/**
 * Set `key` as `error`'s own field, enumerable as a plain object's, so JSON and spread keep it. A
 * function rather than a method: a protected member would make two copies of the class (source and
 * build) refuse each other's errors.
 */
function keep(error: Error, key: string, value: unknown): void {
  Object.defineProperty(error, key, { value, enumerable: true, writable: true, configurable: true })
}

/** Give `cls` the `name` its errors print, on the prototype so it is not a key of each error. */
function nameErrors(cls: { prototype: Error }, name: string): void {
  Object.defineProperty(cls.prototype, "name", { value: name, writable: true, configurable: true })
}

/**
 * An error a Supatype result carries, and the base of every error the SDK throws.
 *
 * An `Error`, so `instanceof Error` holds, a stack is kept, and `String(error)` reads
 * `SupatypeError: <message>`. Its own fields are exactly the result's (`message`, then whichever of
 * `code`, `status`, `field`, `hint` and `details` it has), so reading them, spreading the error, or
 * turning it into JSON gives those fields. A failure in transit keeps what was thrown as `cause`.
 */
export class SupatypeError extends Error implements SupatypeErrorFields {
  declare readonly code?: string | undefined
  declare readonly status?: number | undefined
  declare readonly field?: string | undefined
  declare readonly hint?: string | undefined
  declare readonly details?: string | undefined

  constructor(fields: SupatypeErrorFields, options?: { cause?: unknown }) {
    super(fields.message, options)
    keep(this, "message", fields.message)
    for (const key of ERROR_FIELDS) {
      if (fields[key] !== undefined) keep(this, key, fields[key])
    }
  }

  /** The error's fields as a plain object, which is what JSON gets, and nothing else. */
  toJSON(): SupatypeErrorFields {
    const fields: SupatypeErrorFields = { message: this.message }
    for (const key of ERROR_FIELDS) {
      if (this[key] !== undefined) Object.assign(fields, { [key]: this[key] })
    }
    return fields
  }
}
nameErrors(SupatypeError, "SupatypeError")

/**
 * A sign-in the auth server refused and reported back in the redirect URL.
 *
 * `provider` names the OAuth provider this browser started the sign-in with, when the client
 * remembers one, so an app showing one button per provider can put the message by the right one.
 * It is one more own field, so JSON and spread carry it too.
 */
export class AuthRedirectError extends SupatypeError {
  declare readonly provider?: string | undefined

  constructor(fields: SupatypeErrorFields & { provider?: string | undefined }, options?: { cause?: unknown }) {
    super(fields, options)
    if (fields.provider !== undefined) keep(this, "provider", fields.provider)
  }

  override toJSON(): SupatypeErrorFields & { provider?: string } {
    return { ...super.toJSON(), ...(this.provider !== undefined && { provider: this.provider }) }
  }
}
nameErrors(AuthRedirectError, "AuthRedirectError")

/**
 * An error the SDK throws: a `SupatypeError` whose `code` is always there, with a `helpUrl` to the
 * page that explains it. Its HTTP status, when it has one, is `status`, as on every result.
 */
export class SupatypeCodedError extends SupatypeError {
  declare readonly code: string

  constructor(message: string, code: string, status?: number, options?: { cause?: unknown }) {
    super({ message, code, ...(status !== undefined && { status }) }, options)
  }

  /** The documentation for this error's code. */
  get helpUrl(): string {
    return `${DOCS_BASE}#${this.code.toLowerCase()}`
  }
}
nameErrors(SupatypeCodedError, "SupatypeCodedError")

/** The two values a client cannot send a request without. */
export type ClientValue = "url" | "anonKey"

/**
 * A request made by a client that has no API address or no anon key.
 *
 * Thrown by the request, never by `createClient`: a client created at module scope runs while a
 * framework prerenders a page, which sends nothing and needs neither. It is a setup fault rather
 * than an answer from the server, so no request turns it into `{ data: null, error }`
 * (transportFailure rethrows it): an app that only reads `data` would show an empty page instead.
 */
export class MissingClientValuesError extends SupatypeCodedError {
  /** Which of the two values were still missing when the request was made. */
  readonly missing: readonly ClientValue[]

  constructor(message: string, missing: readonly ClientValue[]) {
    super(message, "MISSING_CLIENT_VALUES")
    this.missing = missing
  }
}
nameErrors(MissingClientValuesError, "MissingClientValuesError")

/**
 * Authentication errors (login failures, token issues, MFA).
 */
export class AuthError extends SupatypeCodedError {
  constructor(message: string, code: string = "AUTH_ERROR", status?: number) {
    super(message, code, status)
  }
}
nameErrors(AuthError, "AuthError")

/** A PostgREST hint or detail line worth keeping: given and not blank. */
function given(text: string | null | undefined): string | undefined {
  return text === null || text === undefined || text === "" ? undefined : text
}

/**
 * PostgREST API errors with structured details. `details` and `hint` are absent when the server
 * gave none, as on every other error.
 */
export class PostgrestError extends SupatypeCodedError {
  constructor(
    message: string,
    code: string = "PGRST000",
    status?: number,
    details?: string | null,
    hint?: string | null,
  ) {
    super(message, code, status)
    const kept = { details: given(details), hint: given(hint) }
    if (kept.details !== undefined) keep(this, "details", kept.details)
    if (kept.hint !== undefined) keep(this, "hint", kept.hint)
  }

  /**
   * Create from a PostgREST error response body.
   */
  static fromResponse(body: {
    message?: string | undefined
    code?: string | undefined
    details?: string | undefined
    hint?: string | undefined
  }, status: number): PostgrestError {
    return new PostgrestError(
      body.message || "PostgREST error",
      body.code || `PGRST${status}`,
      status,
      body.details,
      body.hint,
    )
  }
}
nameErrors(PostgrestError, "PostgrestError")

/**
 * Storage service errors (upload/download failures).
 */
export class StorageError extends SupatypeCodedError {
  constructor(message: string, code: string = "STORAGE_ERROR", status?: number) {
    super(message, code, status)
  }
}
nameErrors(StorageError, "StorageError")

/**
 * Realtime/WebSocket errors.
 */
export class RealtimeError extends SupatypeCodedError {
  constructor(message: string, code: string = "REALTIME_ERROR") {
    super(message, code)
  }
}
nameErrors(RealtimeError, "RealtimeError")

/**
 * Network errors (connection failures, timeouts, DNS).
 */
export class NetworkError extends SupatypeCodedError {
  constructor(message: string, code: string = "NETWORK_ERROR") {
    super(message, code)
  }
}
nameErrors(NetworkError, "NetworkError")

/**
 * Rate limit errors with retry information.
 */
export class RateLimitError extends SupatypeCodedError {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super(`Rate limited. Retry after ${retryAfterSeconds} seconds.`, "RATE_LIMITED", 429)
    this.retryAfterSeconds = retryAfterSeconds
  }
}
nameErrors(RateLimitError, "RateLimitError")

// ── Common error codes ────────────────────────────────────────────

/**
 * The `code` an auth error carries, as the auth server sends it in `error_code`.
 *
 * These were `AUTH_INVALID_CREDENTIALS` and the like, which the server never sends, so comparing
 * an error's code with them never matched. The names are unchanged; the values are the server's.
 */
export const AuthErrorCodes = {
  /** Wrong email or password */
  INVALID_CREDENTIALS: "invalid_credentials",
  USER_NOT_FOUND: "user_not_found",
  EMAIL_NOT_CONFIRMED: "email_not_confirmed",
  PHONE_NOT_CONFIRMED: "phone_not_confirmed",
  SESSION_EXPIRED: "session_expired",
  /** The access token could not be verified */
  INVALID_TOKEN: "bad_jwt",
  /** The request needs a session at a higher assurance level: complete an MFA challenge first */
  MFA_REQUIRED: "insufficient_aal",
  MFA_CHALLENGE_EXPIRED: "mfa_challenge_expired",
  MFA_VERIFICATION_FAILED: "mfa_verification_failed",
  WEAK_PASSWORD: "weak_password",
  /** Sign-up with an email that is already registered sends EMAIL_EXISTS */
  USER_ALREADY_EXISTS: "user_already_exists",
  EMAIL_EXISTS: "email_exists",
  OAUTH_CALLBACK_ERROR: "bad_oauth_callback",
  /** An emailed link or one-time code that has expired or was already used */
  MAGIC_LINK_EXPIRED: "otp_expired",
  OTP_EXPIRED: "otp_expired",
  SIGNUP_DISABLED: "signup_disabled",
  SAME_PASSWORD: "same_password",
  OVER_EMAIL_SEND_RATE_LIMIT: "over_email_send_rate_limit",
  OVER_REQUEST_RATE_LIMIT: "over_request_rate_limit",
} as const

export const StorageErrorCodes = {
  OBJECT_NOT_FOUND: "STORAGE_OBJECT_NOT_FOUND",
  BUCKET_NOT_FOUND: "STORAGE_BUCKET_NOT_FOUND",
  FILE_TOO_LARGE: "STORAGE_FILE_TOO_LARGE",
  INVALID_FILE_TYPE: "STORAGE_INVALID_FILE_TYPE",
  QUOTA_EXCEEDED: "STORAGE_QUOTA_EXCEEDED",
  PRESIGNED_URL_EXPIRED: "STORAGE_PRESIGNED_URL_EXPIRED",
} as const

/**
 * The `code` a REST error carries, as PostgREST 14 sends it.
 *
 * PostgREST's own errors are `PGRST` codes. A database error is passed through under its Postgres
 * SQLSTATE, with no prefix: a unique violation is `23505`, never `PGRST23505`.
 */
export const PostgrestErrorCodes = {
  /** The token could not be decoded or verified: a bad signature, a malformed or empty token */
  JWT_INVALID: "PGRST301",
  /** The token's claims were rejected, an expired token among them (`PGRST301` before PostgREST 13) */
  JWT_EXPIRED: "PGRST303",
  /** Row-level security or a missing grant refused the operation */
  PERMISSION_DENIED: "42501",
  /** `.single()` found no row */
  NOT_FOUND: "PGRST116",
  /** `.single()` found more than one row */
  MULTIPLE_ROWS: "PGRST116",
  /** The request named a column the schema cache does not have */
  SCHEMA_CACHE_MISS: "PGRST204",
  /** Foreign key violation */
  FK_VIOLATION: "23503",
  /** Unique constraint violation */
  UNIQUE_VIOLATION: "23505",
  /** Not-null constraint violation */
  NOT_NULL_VIOLATION: "23502",
  /** Check constraint violation */
  CHECK_VIOLATION: "23514",
  /** Invalid input syntax */
  INVALID_INPUT: "22P02",
  /** The table is not in the schema cache (the SQLSTATE `42P01` before PostgREST 13) */
  UNDEFINED_TABLE: "PGRST205",
  /** Undefined column */
  UNDEFINED_COLUMN: "42703",
} as const

export const RealtimeErrorCodes = {
  /** WebSocket connection failed */
  CONNECTION_FAILED: "REALTIME_CONNECTION_FAILED",
  /** Subscription denied by RLS or auth */
  SUBSCRIPTION_DENIED: "REALTIME_SUBSCRIPTION_DENIED",
  /** Channel error from server */
  CHANNEL_ERROR: "REALTIME_CHANNEL_ERROR",
  /** Connection limit exceeded (429-equivalent for WS) */
  CONNECTION_LIMIT: "REALTIME_CONNECTION_LIMIT",
  /** Heartbeat timeout: server unresponsive */
  HEARTBEAT_TIMEOUT: "REALTIME_HEARTBEAT_TIMEOUT",
} as const

export const NetworkErrorCodes = {
  TIMEOUT: "NETWORK_TIMEOUT",
  CONNECTION_REFUSED: "NETWORK_CONNECTION_REFUSED",
  DNS_FAILURE: "NETWORK_DNS_FAILURE",
} as const

/** Union of all error code constant objects for programmatic access. */
export const ErrorCodes = {
  Auth: AuthErrorCodes,
  Postgrest: PostgrestErrorCodes,
  Storage: StorageErrorCodes,
  Realtime: RealtimeErrorCodes,
  Network: NetworkErrorCodes,
} as const

/**
 * A request that never got an answer, as a result rather than a throw.
 *
 * The client's fetch throws typed errors (a timeout, a rate limit after the last retry), and their
 * code and status are what lets a caller tell "try again later" from "the server is gone", so one
 * of the family is the result as it is, and `instanceof NetworkError` still names it. Anything else
 * thrown is held as the `cause` of a `SupatypeError` carrying its message.
 *
 * A client with no address or anon key is rethrown instead: that request was never sent, and the
 * fix is in the app's setup, which a result an app may never read would hide.
 */
export function transportFailure(e: unknown): SupatypeError {
  if (e instanceof MissingClientValuesError) throw e
  if (e instanceof SupatypeError) return e
  return new SupatypeError({ message: e instanceof Error ? e.message : "Network error" }, { cause: e })
}
