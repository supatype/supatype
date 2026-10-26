import type { SupatypeError as SupatypeErrorShape } from "./types.js"

/**
 * Typed error hierarchy for the Supatype SDK.
 * Every error has a machine-readable `code` field and optional `helpUrl`.
 */

const DOCS_BASE = "https://docs.supatype.com/errors"

/**
 * Base error class for all Supatype SDK errors.
 */
export class SupatypeError extends Error {
  readonly code: string
  readonly helpUrl: string
  readonly statusCode?: number | undefined

  constructor(message: string, code: string, statusCode?: number) {
    super(message)
    this.name = "SupatypeError"
    this.code = code
    this.statusCode = statusCode
    this.helpUrl = `${DOCS_BASE}#${code.toLowerCase()}`
  }
}

/**
 * Authentication errors (login failures, token issues, MFA).
 */
export class AuthError extends SupatypeError {
  constructor(message: string, code: string = "AUTH_ERROR", statusCode?: number) {
    super(message, code, statusCode)
    this.name = "AuthError"
  }
}

/**
 * PostgREST API errors with structured details.
 */
export class PostgrestError extends SupatypeError {
  readonly details: string | null
  readonly hint: string | null

  constructor(
    message: string,
    code: string = "PGRST000",
    statusCode?: number,
    details?: string | null,
    hint?: string | null,
  ) {
    super(message, code, statusCode)
    this.name = "PostgrestError"
    this.details = details ?? null
    this.hint = hint ?? null
  }

  /**
   * Create from a PostgREST error response body.
   */
  static fromResponse(body: {
    message?: string | undefined
    code?: string | undefined
    details?: string | undefined
    hint?: string | undefined
  }, statusCode: number): PostgrestError {
    return new PostgrestError(
      body.message || "PostgREST error",
      body.code || `PGRST${statusCode}`,
      statusCode,
      body.details,
      body.hint,
    )
  }
}

/**
 * Storage service errors (upload/download failures).
 */
export class StorageError extends SupatypeError {
  constructor(message: string, code: string = "STORAGE_ERROR", statusCode?: number) {
    super(message, code, statusCode)
    this.name = "StorageError"
  }
}

/**
 * Realtime/WebSocket errors.
 */
export class RealtimeError extends SupatypeError {
  constructor(message: string, code: string = "REALTIME_ERROR") {
    super(message, code)
    this.name = "RealtimeError"
  }
}

/**
 * Network errors (connection failures, timeouts, DNS).
 */
export class NetworkError extends SupatypeError {
  constructor(message: string, code: string = "NETWORK_ERROR") {
    super(message, code)
    this.name = "NetworkError"
  }
}

/**
 * Rate limit errors with retry information.
 */
export class RateLimitError extends SupatypeError {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super(
      `Rate limited. Retry after ${retryAfterSeconds} seconds.`,
      "RATE_LIMITED",
      429,
    )
    this.name = "RateLimitError"
    this.retryAfterSeconds = retryAfterSeconds
  }
}

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
 * code and status are what lets a caller tell "try again later" from "the server is gone".
 */
export function transportFailure(e: unknown): SupatypeErrorShape {
  if (e instanceof SupatypeError) {
    return {
      message: e.message,
      code: e.code,
      ...(e.statusCode !== undefined && { status: e.statusCode }),
    }
  }
  return { message: e instanceof Error ? e.message : "Network error" }
}
