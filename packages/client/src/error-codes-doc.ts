/**
 * Error codes documentation — Gap Appendices task 35
 *
 * Published list of all Supatype error codes with descriptions and suggested
 * fixes. Accessible at docs.supatype.io/errors.
 *
 * Each SDK error includes a `helpUrl` field linking to the relevant section
 * on the documentation page.
 */

export interface ErrorCodeEntry {
  /** Machine-readable error code (e.g. "AUTH_INVALID_CREDENTIALS"). */
  code: string
  /** Human-readable short description. */
  description: string
  /** Suggested fix or resolution. */
  suggestion: string
  /** HTTP status code typically associated with this error. */
  httpStatus?: number | undefined
  /** Category grouping. */
  category: "auth" | "postgrest" | "storage" | "realtime" | "network"
}

export const ERROR_CODES_DOCUMENTATION: readonly ErrorCodeEntry[] = [
  // ── Auth errors ──────────────────────────────────────────────────────────
  {
    code: "AUTH_INVALID_CREDENTIALS",
    description: "The email/password combination is incorrect.",
    suggestion: "Check the email and password. If forgotten, use resetPasswordForEmail().",
    httpStatus: 400,
    category: "auth",
  },
  {
    code: "AUTH_USER_NOT_FOUND",
    description: "No user exists with the provided identifier.",
    suggestion: "Verify the email address. The user may need to sign up first.",
    httpStatus: 404,
    category: "auth",
  },
  {
    code: "AUTH_EMAIL_NOT_CONFIRMED",
    description: "The user's email has not been confirmed yet.",
    suggestion: "Check inbox for the confirmation email. Use auth.resend({ type: 'signup' }) to re-send.",
    httpStatus: 403,
    category: "auth",
  },
  {
    code: "AUTH_PHONE_NOT_CONFIRMED",
    description: "The user's phone number has not been verified.",
    suggestion: "Complete the phone OTP verification flow.",
    httpStatus: 403,
    category: "auth",
  },
  {
    code: "AUTH_SESSION_EXPIRED",
    description: "The session has expired and the refresh token is no longer valid.",
    suggestion: "Sign the user in again. Implement automatic token refresh with onAuthStateChange.",
    httpStatus: 401,
    category: "auth",
  },
  {
    code: "AUTH_INVALID_TOKEN",
    description: "The provided JWT is malformed, expired, or signed with a different secret.",
    suggestion: "Ensure the token is from the correct project. Check expiry. Re-authenticate.",
    httpStatus: 401,
    category: "auth",
  },
  {
    code: "AUTH_MFA_REQUIRED",
    description: "Multi-factor authentication is required to complete this action.",
    suggestion: "Call mfa.challenge() and mfa.verify() with the user's TOTP code.",
    httpStatus: 403,
    category: "auth",
  },
  {
    code: "AUTH_MFA_CHALLENGE_EXPIRED",
    description: "The MFA challenge has expired.",
    suggestion: "Create a new challenge with mfa.challenge() and try again.",
    httpStatus: 400,
    category: "auth",
  },
  {
    code: "AUTH_MFA_VERIFICATION_FAILED",
    description: "The MFA verification code is incorrect.",
    suggestion: "Ensure the TOTP code is current (codes rotate every 30 seconds).",
    httpStatus: 400,
    category: "auth",
  },
  {
    code: "AUTH_WEAK_PASSWORD",
    description: "The password does not meet the minimum strength requirements.",
    suggestion: "Use a password with at least 8 characters including mixed case and numbers.",
    httpStatus: 422,
    category: "auth",
  },
  {
    code: "AUTH_USER_ALREADY_EXISTS",
    description: "A user with this email or phone already exists.",
    suggestion: "Use signInWithPassword() instead, or try a different email.",
    httpStatus: 409,
    category: "auth",
  },
  {
    code: "AUTH_OAUTH_CALLBACK_ERROR",
    description: "The OAuth provider returned an error during the callback.",
    suggestion: "Check the provider configuration (client ID, secret, redirect URL).",
    httpStatus: 400,
    category: "auth",
  },
  {
    code: "AUTH_MAGIC_LINK_EXPIRED",
    description: "The magic link has expired (default: 10 minutes).",
    suggestion: "Request a new magic link with signInWithOtp({ email }).",
    httpStatus: 400,
    category: "auth",
  },

  // ── PostgREST errors ─────────────────────────────────────────────────────
  {
    code: "PGRST301",
    description: "JWT expired or missing. PostgREST could not authenticate the request.",
    suggestion: "Refresh the user's session or re-authenticate. Check that the apikey header is set.",
    httpStatus: 401,
    category: "postgrest",
  },
  {
    code: "PGRST302",
    description: "Permission denied. RLS policy blocked access to the requested resource.",
    suggestion: "Review your access rules in the schema. Ensure the user has the required role.",
    httpStatus: 403,
    category: "postgrest",
  },
  {
    code: "PGRST116",
    description: "No rows returned when a single row was expected.",
    suggestion: "Use .maybeSingle() instead of .single() if the record may not exist.",
    httpStatus: 406,
    category: "postgrest",
  },
  {
    code: "PGRST204",
    description: "PostgREST schema cache is stale. The table or function may have changed.",
    suggestion: "PostgREST will reload its cache automatically. Retry the request.",
    httpStatus: 503,
    category: "postgrest",
  },
  {
    code: "PGRST23503",
    description: "Foreign key constraint violation. The referenced record does not exist.",
    suggestion: "Ensure the related record exists before creating/updating. Check relation fields.",
    httpStatus: 409,
    category: "postgrest",
  },
  {
    code: "PGRST23505",
    description: "Unique constraint violation. A record with this value already exists.",
    suggestion: "Use .upsert() for insert-or-update, or check for existing records first.",
    httpStatus: 409,
    category: "postgrest",
  },
  {
    code: "PGRST23502",
    description: "Not-null constraint violation. A required field is missing.",
    suggestion: "Include all required fields in the insert/update payload.",
    httpStatus: 400,
    category: "postgrest",
  },
  {
    code: "PGRST23514",
    description: "Check constraint violation. A field value does not satisfy the constraint.",
    suggestion: "Ensure enum values match declared options. Check field validation rules.",
    httpStatus: 400,
    category: "postgrest",
  },
  {
    code: "PGRST22P02",
    description: "Invalid input syntax. The value cannot be cast to the expected type.",
    suggestion: "Check that field values match the expected types (e.g., UUID format, number format).",
    httpStatus: 400,
    category: "postgrest",
  },
  {
    code: "PGRST42P01",
    description: "Table does not exist. The schema may need to be pushed.",
    suggestion: "Run `npx supatype push` to apply your schema to the database.",
    httpStatus: 404,
    category: "postgrest",
  },
  {
    code: "PGRST42703",
    description: "Column does not exist. The field may have been renamed or removed.",
    suggestion: "Check your query column names against the current schema.",
    httpStatus: 400,
    category: "postgrest",
  },

  // ── Storage errors ───────────────────────────────────────────────────────
  {
    code: "STORAGE_OBJECT_NOT_FOUND",
    description: "The requested file does not exist in the bucket.",
    suggestion: "Verify the file path. List bucket contents with storage.from('bucket').list().",
    httpStatus: 404,
    category: "storage",
  },
  {
    code: "STORAGE_BUCKET_NOT_FOUND",
    description: "The specified bucket does not exist.",
    suggestion: "Check the bucket name. Buckets are created from your schema's storage fields.",
    httpStatus: 404,
    category: "storage",
  },
  {
    code: "STORAGE_FILE_TOO_LARGE",
    description: "The uploaded file exceeds the maximum allowed size.",
    suggestion: "Compress the file or request a larger limit. Check field.image({ maxSize }) config.",
    httpStatus: 413,
    category: "storage",
  },
  {
    code: "STORAGE_INVALID_FILE_TYPE",
    description: "The file's Content-Type is not in the bucket's allowed types list.",
    suggestion: "Check field.image({ accept: [...] }) or field.file({ accept: [...] }) configuration.",
    httpStatus: 415,
    category: "storage",
  },
  {
    code: "STORAGE_QUOTA_EXCEEDED",
    description: "Uploading this file would exceed your project's total storage quota.",
    suggestion: "Delete unused files or upgrade your plan for more storage.",
    httpStatus: 507,
    category: "storage",
  },
  {
    code: "STORAGE_PRESIGNED_URL_EXPIRED",
    description: "The pre-signed URL has expired.",
    suggestion: "Generate a new pre-signed URL with createSignedUrl().",
    httpStatus: 403,
    category: "storage",
  },

  // ── Realtime errors ──────────────────────────────────────────────────────
  {
    code: "REALTIME_CONNECTION_FAILED",
    description: "WebSocket connection to the Realtime server could not be established.",
    suggestion: "Check network connectivity and that the Realtime service is running.",
    category: "realtime",
  },
  {
    code: "REALTIME_SUBSCRIPTION_DENIED",
    description: "The subscription was denied due to RLS or authentication.",
    suggestion: "Ensure the user has read access to the subscribed table.",
    category: "realtime",
  },
  {
    code: "REALTIME_CHANNEL_ERROR",
    description: "An error occurred on the subscribed channel.",
    suggestion: "Check the channel name and re-subscribe.",
    category: "realtime",
  },
  {
    code: "REALTIME_CONNECTION_LIMIT",
    description: "The project's concurrent WebSocket connection limit has been exceeded.",
    suggestion: "Close unused subscriptions or upgrade your plan for more connections.",
    category: "realtime",
  },
  {
    code: "REALTIME_HEARTBEAT_TIMEOUT",
    description: "The Realtime server did not respond to heartbeat pings.",
    suggestion: "Check server health. The client will attempt to reconnect automatically.",
    category: "realtime",
  },

  // ── Network errors ───────────────────────────────────────────────────────
  {
    code: "NETWORK_TIMEOUT",
    description: "The request timed out before receiving a response.",
    suggestion: "Increase the timeout via createClient({ timeout: 60000 }) or check server load.",
    category: "network",
  },
  {
    code: "NETWORK_CONNECTION_REFUSED",
    description: "The server refused the connection.",
    suggestion: "Ensure the Supatype services are running. Check the URL in createClient().",
    category: "network",
  },
  {
    code: "NETWORK_DNS_FAILURE",
    description: "DNS lookup failed for the API hostname.",
    suggestion: "Check the URL. Verify DNS configuration and network connectivity.",
    category: "network",
  },
  {
    code: "RATE_LIMITED",
    description: "Too many requests. The server returned HTTP 429.",
    suggestion: "Wait for the Retry-After period. Implement client-side debouncing/throttling.",
    httpStatus: 429,
    category: "network",
  },
] as const

/**
 * Look up documentation for a specific error code.
 */
export function getErrorDocumentation(code: string): ErrorCodeEntry | undefined {
  return ERROR_CODES_DOCUMENTATION.find((entry) => entry.code === code)
}

/**
 * Get all error codes for a specific category.
 */
export function getErrorCodesByCategory(
  category: ErrorCodeEntry["category"],
): readonly ErrorCodeEntry[] {
  return ERROR_CODES_DOCUMENTATION.filter((entry) => entry.category === category)
}
