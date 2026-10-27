export interface CookieOptions {
  maxAge?: number | undefined
  domain?: string | undefined
  path?: string | undefined
  secure?: boolean | undefined
  httpOnly?: boolean | undefined
  sameSite?: "strict" | "lax" | "none" | undefined
}

/** One cookie to write: `value` is unencoded, for the framework to encode as it writes any cookie. */
export interface CookieToSet {
  name: string
  value: string
  options?: CookieOptions | undefined
}

export interface CookieAdapter {
  getAll(): Array<{ name: string; value: string }>
  /**
   * Writes the session cookie whenever the session changes on the server: a refreshed token, a
   * sign-in, or a sign-out (an empty value with `maxAge: 0`). Leave it out where cookies cannot be
   * written, such as a Server Component.
   */
  setAll?(cookies: CookieToSet[]): void
}

export interface ServerClientOptions {
  cookies: CookieAdapter
  /** Cookie name prefix. Default: "st". The browser client writes its session as `st-auth-token`. */
  cookiePrefix?: string | undefined
}
