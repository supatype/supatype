/**
 * Typed error hierarchy for the Supatype SDK.
 * Every error has a machine-readable `code` field and optional `helpUrl`.
 */

const DOCS_BASE = "https://docs.supatype.io/errors"

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

export const AuthErrorCodes = {
  INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  USER_NOT_FOUND: "AUTH_USER_NOT_FOUND",
  EMAIL_NOT_CONFIRMED: "AUTH_EMAIL_NOT_CONFIRMED",
  PHONE_NOT_CONFIRMED: "AUTH_PHONE_NOT_CONFIRMED",
  SESSION_EXPIRED: "AUTH_SESSION_EXPIRED",
  INVALID_TOKEN: "AUTH_INVALID_TOKEN",
  MFA_REQUIRED: "AUTH_MFA_REQUIRED",
  MFA_CHALLENGE_EXPIRED: "AUTH_MFA_CHALLENGE_EXPIRED",
  MFA_VERIFICATION_FAILED: "AUTH_MFA_VERIFICATION_FAILED",
  WEAK_PASSWORD: "AUTH_WEAK_PASSWORD",
  USER_ALREADY_EXISTS: "AUTH_USER_ALREADY_EXISTS",
  OAUTH_CALLBACK_ERROR: "AUTH_OAUTH_CALLBACK_ERROR",
  MAGIC_LINK_EXPIRED: "AUTH_MAGIC_LINK_EXPIRED",
} as const

export const StorageErrorCodes = {
  OBJECT_NOT_FOUND: "STORAGE_OBJECT_NOT_FOUND",
  BUCKET_NOT_FOUND: "STORAGE_BUCKET_NOT_FOUND",
  FILE_TOO_LARGE: "STORAGE_FILE_TOO_LARGE",
  INVALID_FILE_TYPE: "STORAGE_INVALID_FILE_TYPE",
  QUOTA_EXCEEDED: "STORAGE_QUOTA_EXCEEDED",
  PRESIGNED_URL_EXPIRED: "STORAGE_PRESIGNED_URL_EXPIRED",
} as const

export const PostgrestErrorCodes = {
  /** JWT expired or missing */
  JWT_EXPIRED: "PGRST301",
  /** No permission — RLS policy denied access */
  PERMISSION_DENIED: "PGRST302",
  /** Requested resource not found */
  NOT_FOUND: "PGRST116",
  /** Multiple rows returned when single expected */
  MULTIPLE_ROWS: "PGRST116",
  /** Schema cache miss — PostgREST needs reload */
  SCHEMA_CACHE_MISS: "PGRST204",
  /** Foreign key violation */
  FK_VIOLATION: "PGRST23503",
  /** Unique constraint violation */
  UNIQUE_VIOLATION: "PGRST23505",
  /** Not-null constraint violation */
  NOT_NULL_VIOLATION: "PGRST23502",
  /** Check constraint violation */
  CHECK_VIOLATION: "PGRST23514",
  /** Invalid input syntax */
  INVALID_INPUT: "PGRST22P02",
  /** Undefined table */
  UNDEFINED_TABLE: "PGRST42P01",
  /** Undefined column */
  UNDEFINED_COLUMN: "PGRST42703",
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
  /** Heartbeat timeout — server unresponsive */
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
