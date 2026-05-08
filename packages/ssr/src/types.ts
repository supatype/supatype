export interface CookieOptions {
  maxAge?: number | undefined
  domain?: string | undefined
  path?: string | undefined
  secure?: boolean | undefined
  httpOnly?: boolean | undefined
  sameSite?: "strict" | "lax" | "none" | undefined
}

export interface CookieAdapter {
  getAll(): Array<{ name: string; value: string }>
  setAll(cookies: Array<{ name: string; value: string; options?: CookieOptions | undefined }>): void
}

export interface ServerClientOptions {
  cookies: CookieAdapter
  /** Cookie name prefix. Default: "st". Supatype sets cookies as `st-<ref>-auth-token`. */
  cookiePrefix?: string | undefined
}
