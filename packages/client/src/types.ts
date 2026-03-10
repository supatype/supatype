// ─── Auth types ───────────────────────────────────────────────────────────────

export interface User {
  id: string
  email?: string | undefined
  phone?: string | undefined
  role?: string | undefined
  appMetadata: Record<string, unknown>
  userMetadata: Record<string, unknown>
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

// ─── Database generic ─────────────────────────────────────────────────────────

export interface TableDef {
  Row: Record<string, unknown>
  Insert: Record<string, unknown>
  Update: Record<string, unknown>
}

export interface AnyDatabase {
  public: {
    Tables: Record<string, TableDef>
  }
}

// ─── Client config ────────────────────────────────────────────────────────────

export interface SupatypeClientConfig {
  /** Base URL of the Supatype gateway (e.g. http://localhost:8000) */
  url: string
  /** Anon JWT key */
  anonKey: string
  auth?: {
    /** Persist session across page reloads (browser only). Default: true */
    persistSession?: boolean | undefined
    /** localStorage key to use for session storage. Default: "supatype.auth.session" */
    storageKey?: string | undefined
  } | undefined
}
