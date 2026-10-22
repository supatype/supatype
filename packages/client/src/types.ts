import type { TableRelationship } from "./select-types.js"

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

/**
 * OAuth / magic-link redirect flow.
 * - `pkce`: authorize with code_challenge; app exchanges `?code=` via `exchangeCodeForSession`.
 * - `implicit`: tokens returned in the URL hash (`#access_token=…`).
 *
 * Web `signInWithOAuth` defaults to `implicit` for backward compatibility.
 * React Native helpers should pass `pkce` (recommended default for mobile).
 */
export type AuthFlowType = "pkce" | "implicit"

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
  /**
   * The column a field validator refused, when the refusal came from one.
   *
   * Carried separately from `message` so a client does not parse prose to know which input to mark.
   * A validator's whole reason for existing over a `beforeChange` hook is that its refusal names a
   * field; losing that here would leave the message in a banner, which is what a hook already gives
   * you.
   */
  field?: string | undefined
  /**
   * What the server suggests doing instead, when it said. PostgREST passes a Postgres `HINT`
   * through, and the gateway adds one to an insert into a drafts model that is refused for asking
   * for its row back, naming `supatype.create_record` and `supatype.create_records`.
   */
  hint?: string | undefined
  /**
   * The detail line Postgres attached, when it gave one. A unique violation names its columns and
   * values here (`Key (slug)=(intro) already exists.`), which is how a caller learns which of the
   * values it sent collided without parsing the message.
   */
  details?: string | undefined
}

/**
 * A sign-in the auth server refused and reported back in the redirect URL.
 *
 * `provider` names the OAuth provider this browser started the sign-in with, when the client
 * remembers one, so an app showing one button per provider can put the message by the right one.
 */
export interface AuthRedirectError extends SupatypeError {
  provider?: string | undefined
}

// ─── Query result ─────────────────────────────────────────────────────────────

/**
 * A column in the response that carries a read restriction.
 *
 * Postgres cannot omit a column, the result-set shape is fixed and identical for every row
 *- so a column you may not read comes back as `null`, indistinguishable on the wire from a
 * value that is genuinely null. This says which nulls are explicable by masking.
 *
 * Advisory. It describes the schema's restrictions, not a decision: what you can actually
 * read is enforced in the database, and ignoring or tampering with this changes nothing.
 */
export interface MaskedField {
  column: string
  /**
   * `identity`: the verdict is the same for every row in this response, so a `null` in the
   * column is explicable by masking for the whole result set.
   *
   * `row`: the rule reads the row, so only *some* nulls are masked values and the rest are
   * genuinely null. Deliberately not narrowed further: the header is computed before the
   * query runs, so claiming more would be a guess.
   */
  scope: "identity" | "row"
}

export interface QueryResult<TData> {
  data: TData | null
  error: SupatypeError | null
  count: number | null
  meta?: {
    cacheStatus?: "HIT" | "MISS" | "BYPASS" | undefined
    /** Present only when the response named restricted columns. Absent means "not stated". */
    maskedFields?: MaskedField[] | undefined
  } | undefined
}

// ─── RPC result ──────────────────────────────────────────────────────────────

/**
 * Options for {@link SupatypeClient.rpc}.
 *
 * `schema` is not decoration. PostgREST resolves `/rpc/<name>` against the
 * **default profile**, which is the first schema on the exposed list, so a
 * function living anywhere else is unreachable without naming its schema. The
 * generated publishing functions live in `supatype` for exactly the reason they
 * are generated at all: they are the stack's, not the project's, and putting them
 * in the managed schema would collide with a model called `publish`.
 */
export interface RpcOptions {
  head?: boolean | undefined
  count?: "exact" | "planned" | "estimated" | undefined
  /** Postgres schema holding the function, sent as `Content-Profile`. */
  schema?: string | undefined
  /**
   * Retry this call on a transient failure (a dropped connection, a 5xx, a 429). Default: false.
   *
   * An RPC is a POST, and the client cannot tell a read from a write: a call that failed in flight
   * may already have run, and running it again could apply its writes twice. Set this for a
   * function that only reads, or whose writes are safe to repeat. A `head` call is always retried.
   */
  idempotent?: boolean | undefined
}

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
  /**
   * The foreign keys this table holds, which an embedded select is resolved through. Generated for
   * every table; a hand-written definition without them can still select its own columns.
   */
  Relationships?: readonly TableRelationship[] | undefined
  /**
   * `true` on a model that keeps drafts, where `update` saves a new draft of each record and
   * `{ publish: true }` publishes it in the same call. Generated; absent on every other table. A
   * hand-written definition that leaves it unsaid is offered the option, and the client refuses it
   * at run time on a table it does not know keeps drafts.
   */
  Drafts?: boolean | undefined
}

/** What `update` takes beyond the changes, on a model that keeps drafts. */
export interface DraftUpdateOptions {
  /**
   * Publish each new draft in the same call, so the live rows change and the history records the
   * version that went live. Without it the live rows stay as they are until a version is published.
   */
  publish?: boolean | undefined
}

/**
 * The options `update` takes on `TDef`: {@link DraftUpdateOptions} on a model that keeps drafts, or
 * one whose definition does not say; nothing on a generated table that keeps none.
 */
export type UpdateOptions<TDef extends TableDef> =
  TDef extends { Drafts: true } ? DraftUpdateOptions
  : "Drafts" extends keyof TDef ? (TDef["Drafts"] extends false | undefined ? never : DraftUpdateOptions)
  : never

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

/**
 * Row type for an augmented table name (from generated `supatype` output).
 *
 * Reach for this rather than indexing the generated database type by hand. Only `TableInsert`
 * existed, so every consumer that wanted a row type wrote
 * `Database["public"]["Tables"]["post"]["Row"]` instead, including our own examples in 23 places.
 * That spelling names four internal structures to say one thing, and it breaks the moment any of
 * them is renamed.
 */
export type TableRow<TTable extends keyof SupatypeModels & string> =
  [keyof SupatypeModels] extends [never]
    ? Record<string, unknown>
    : TTable extends keyof SupatypeModels
      ? SupatypeModels[TTable] extends { Row: infer R }
        ? R
        : Record<string, unknown>
      : Record<string, unknown>

/** Update payload for an augmented table name (from generated `supatype` output). */
export type TableUpdate<TTable extends keyof SupatypeModels & string> =
  [keyof SupatypeModels] extends [never]
    ? Record<string, unknown>
    : TTable extends keyof SupatypeModels
      ? SupatypeModels[TTable] extends { Update: infer U }
        ? U
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

/** Sync or async key-value store for auth session persistence (e.g. AsyncStorage in React Native). */
export interface AuthStorage {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

/**
 * The schema holding one draft view per versioned model, selected by `Accept-Profile`.
 *
 * Stated here as well as in the CLI (`project-config.ts`, which puts it on `PGRST_DB_SCHEMA`) and
 * the engine (which creates the views), because the SDK ships standalone and depending on a
 * workspace package for one identifier would be a worse trade than three call sites naming it.
 * Changing it means changing all three, the same as `api` for the field-masking views.
 */
export const DRAFT_SCHEMA = "draft"

/**
 * The schema holding the generated publishing functions: `create_record`, `create_draft`, `publish`
 * and the rest. PostgREST resolves `/rpc/<name>` against the default profile, so every call to one
 * names this schema with `Content-Profile`.
 */
export const PUBLISHING_SCHEMA = "supatype"

export interface SelectQueryOptions {
  count?: "exact" | "planned" | "estimated" | undefined
  head?: boolean | undefined
  /**
   * PostgREST schema to read from, sent as `Accept-Profile`.
   *
   * Set by `.draft()` rather than by hand: the point of a profile here is that a draft has the same
   * table name and the same row type as what it is a draft of, so the only thing that changes
   * between reading live content and reading the pending edit is which schema answers.
   */
  profile?: string | undefined
}

export interface SupatypeClientConfig {
  /** Base URL of the Supatype gateway (e.g. http://localhost:18473) */
  url: string
  /** Anon JWT key */
  anonKey: string
  /**
   * Service role key: bypasses row-level security.
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
    /**
     * Custom session store. When set, replaces browser localStorage/cookie persistence.
     * React Native: pass an AsyncStorage or expo-secure-store adapter.
     */
    storage?: AuthStorage | undefined
    /**
     * Finish a sign-in the auth server has just redirected back with (OAuth, magic link, recovery
     * link): tokens in the URL fragment or a PKCE `code` in the query become the session, `SIGNED_IN`
     * is emitted, and the parameters are removed from the address bar. Browser only. Default: true,
     * as supabase-js's option of the same name. `auth.initialize()` reports a refusal in the URL.
     */
    detectSessionInUrl?: boolean | undefined
  } | undefined
  /**
   * Retry a transient failure (a dropped connection, a 5xx, a 429). Default: true.
   *
   * Only reads are retried: GET and HEAD requests (table selects, storage downloads, `getUser`), and
   * the few reads sent as POST (storage `list`, signed URLs). Every other request is sent once,
   * whatever this says: a write that failed in flight may still have been applied, and sending it
   * again could apply it twice. `rpc`, `graphql` and `functions.invoke` take `idempotent: true` per
   * call to opt in.
   */
  retry?: boolean | undefined
  /**
   * Request timeout in milliseconds. Default: 30000 (30 seconds).
   *
   * Applies to every HTTP request the client makes: tables, `rpc`, `graphql`, `functions`, auth and
   * storage, uploads included, so raise it for large uploads on slow links. The realtime socket is
   * not an HTTP request and is not covered.
   */
  timeout?: number | undefined
  /**
   * In-memory GET query cache. When omitted, a shared default cache is used.
   */
  queryCache?: import("./query-cache.js").QueryCache | undefined
  /**
   * Pre-load a session at construction time (SSR use case).
   * Used by `@supatype/ssr` to inject a cookie-parsed session into the client
   * before any requests are made.
   */
  initialSession?: Session | undefined
  /**
   * A preview link's code, used as this client's whole credential.
   *
   * Set it on a client built to serve one preview request. The code names a link the project can
   * revoke, and the client exchanges it for a token that lives about a minute. That token carries
   * no subject, so the bearer is nobody in particular: the database's own policy decides what they
   * may read, and there is no admin key anywhere on the path.
   *
   * **It wins over a signed-in session, deliberately.** A preview route is opened by whoever was
   * sent the link, and some of them will already be logged in as someone with no access to the
   * draft. Falling back to that session would show them "not found" and send them to ask why the
   * post had been deleted.
   *
   * Refused alongside `serviceRoleKey`: a route that has both is a route sending admin credentials
   * down a path meant for strangers, which is the mistake this feature exists to remove.
   */
  previewCode?: string | undefined
  /**
   * Extra headers merged into every request (e.g. Studio `X-Supatype-Environment`). A function is
   * read on every request, for a header that changes for the life of the client.
   */
  headers?: Record<string, string> | (() => Record<string, string>) | undefined
}
