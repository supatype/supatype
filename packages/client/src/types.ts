// ─── Auth types ───────────────────────────────────────────────────────────────

export interface UserIdentity {
  id: string
  userId: string
  identityData: Record<string, unknown>
  identityId: string
  provider: string
  createdAt: string
  updatedAt: string
  lastSignInAt?: string | undefined
}

export interface Factor {
  id: string
  friendlyName?: string | undefined
  factorType: "totp" | "phone" | "webauthn"
  status: "verified" | "unverified"
  createdAt: string
  updatedAt: string
  phone?: string | undefined
}

export interface User {
  id: string
  email?: string | undefined
  phone?: string | undefined
  role?: string | undefined
  isAnonymous?: boolean | undefined
  appMetadata: Record<string, unknown>
  userMetadata: Record<string, unknown>
  identities?: UserIdentity[] | undefined
  factors?: Factor[] | undefined
  createdAt: string
  updatedAt: string
}

export interface Session {
  accessToken: string
  tokenType: string
  expiresIn: number
  expiresAt?: number | undefined
  refreshToken: string
  user: User
}

export type AuthChangeEvent =
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED"
  | "PASSWORD_RECOVERY"
  | "MFA_CHALLENGE_VERIFIED"

// ─── MFA types ──────────────────────────────────────────────────────────────

export interface AuthMFAEnrollResponse {
  /** The MFA factor ID */
  id: string
  /** Factor type: totp, phone, or webauthn */
  type: string
  /** Friendly name for the factor */
  friendlyName: string
  /** TOTP-specific data (only present for totp factor type) */
  totp?: {
    /** QR code SVG string */
    qrCode: string
    /** TOTP secret */
    secret: string
    /** TOTP URI for manual entry */
    uri: string
  } | undefined
  /** Phone number (only present for phone factor type) */
  phone?: string | undefined
}

export interface AuthMFAChallengeResponse {
  /** The challenge ID */
  id: string
  /** Factor type */
  type: string
  /** Challenge expiry timestamp (Unix epoch seconds) */
  expiresAt: number
}

export interface AuthMFAVerifyResponse {
  /** Access token */
  accessToken: string
  tokenType: string
  expiresIn: number
  expiresAt?: number | undefined
  refreshToken: string
  user: User
}

export interface AuthMFAListFactorsResponse {
  /** All factors including unverified */
  all: Factor[]
  /** Only verified TOTP factors */
  totp: Factor[]
  /** Only verified phone factors */
  phone: Factor[]
}

export type OtpType =
  | "signup"
  | "magiclink"
  | "recovery"
  | "invite"
  | "email_change"
  | "sms"
  | "phone_change"
  | "email"

// ─── Error type ───────────────────────────────────────────────────────────────

export interface SupatypeError {
  message: string
  status?: number | undefined
  code?: string | undefined
}

// ─── Query result ─────────────────────────────────────────────────────────────

export interface QueryResult<TData> {
  data: TData | null
  error: SupatypeError | null
  count: number | null
}

// ─── RPC result ──────────────────────────────────────────────────────────────

export interface RpcResult<TData> {
  data: TData | null
  error: SupatypeError | null
}

// ─── Database generic ─────────────────────────────────────────────────────────

export interface TableDef {
  Row: Record<string, unknown>
  /**
   * Columns the database fills (`gen_random_uuid()`, `now()`, sequences, etc.)
   * are optional here even when required on {@link TableDef.Row}.
   */
  Insert: Record<string, unknown>
  Update: Record<string, unknown>
}

/**
 * Module augmentation anchors used by generated `supatype` types output.
 *
 * Example generated output:
 * declare module "@supatype/client" {
 *   interface SupatypeModels {
 *     post: { Row: PostRow; Insert: PostInsert; Update: PostUpdate }
 *   }
 * }
 */
export interface SupatypeModels {}
export interface SupatypeBuckets {}
export interface SupatypeFunctions {}

/**
 * Insert payload for an augmented table name (from generated `supatype` output).
 *
 * For inserts from plain objects, prefer this over re-stating column unions.
 */
export type TableInsert<TTable extends keyof SupatypeModels & string> =
  [keyof SupatypeModels] extends [never]
    ? Record<string, unknown>
    : TTable extends keyof SupatypeModels
      ? SupatypeModels[TTable] extends { Insert: infer I }
        ? I
        : Record<string, unknown>
      : Record<string, unknown>

type ModelDefFromAugmented<T> =
  T extends TableDef
    ? T
    : T extends Record<string, unknown>
      ? { Row: T; Insert: Partial<T>; Update: Partial<T> }
      : TableDef

export type AugmentedTables =
  [keyof SupatypeModels] extends [never]
    ? Record<string, TableDef>
    : {
        [K in keyof SupatypeModels & string]: ModelDefFromAugmented<SupatypeModels[K]>
      }

export type AugmentedFunctions =
  [keyof SupatypeFunctions] extends [never]
    ? Record<string, FunctionDef>
    : {
        [K in keyof SupatypeFunctions & string]:
          SupatypeFunctions[K] extends FunctionDef ? SupatypeFunctions[K] : FunctionDef
      }

export interface AugmentedDatabase {
  public: {
    Tables: AugmentedTables
    Functions?: AugmentedFunctions | undefined
  }
}

/**
 * Describes the shape of a Postgres function for typed `.rpc()` calls.
 * Generated by the Supatype engine from detected Postgres functions.
 */
export interface FunctionDef {
  Args: Record<string, unknown>
  Returns: unknown
}

export interface AnyDatabase {
  public: {
    Tables: Record<string, TableDef>
    Functions?: Record<string, FunctionDef> | undefined
  }
}

// ─── Client config ────────────────────────────────────────────────────────────

export interface SupatypeClientConfig {
  /** Base URL of the Supatype gateway (e.g. http://localhost:18473) */
  url: string
  /** Anon JWT key */
  anonKey: string
  /**
   * Service role key — bypasses row-level security.
   * Only set this in trusted server-side or developer-tool contexts.
   * Never expose to end-user clients.
   */
  serviceRoleKey?: string | undefined
  auth?: {
    /** Persist session across page reloads (browser only). Default: true */
    persistSession?: boolean | undefined
    /** localStorage key to use for session storage. Default: "supatype.auth.session" */
    storageKey?: string | undefined
    /**
     * Cookie prefix used for browser-written auth cookie.
     * `@supatype/ssr` reads `<prefix>-auth-token` (and `<prefix>-*-auth-token` forms).
     * Default: `"st"`.
     */
    cookiePrefix?: string | undefined
  } | undefined
  /**
   * Disable automatic retry for transient errors.
   * Default: true (retries enabled).
   */
  retry?: boolean | undefined
  /**
   * Request timeout in milliseconds. Default: 30000 (30 seconds).
   * Applied to every HTTP request made by the client.
   */
  timeout?: number | undefined
  /**
   * Pre-load a session at construction time (SSR use case).
   * Used by `@supatype/ssr` to inject a cookie-parsed session into the client
   * before any requests are made.
   */
  initialSession?: Session | undefined
}
