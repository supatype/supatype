import type {
  AuthChangeEvent,
  Session,
  SupatypeError,
  User,
} from "./types.js"

type AuthListener = (event: AuthChangeEvent, session: Session | null) => void

export class AuthClient {
  private readonly url: string
  private readonly baseHeaders: Record<string, string>
  private currentSession: Session | null = null
  private readonly listeners = new Map<string, AuthListener>()
  private listenerIdCounter = 0

  constructor(url: string, baseHeaders: Record<string, string>) {
    this.url = url
    this.baseHeaders = baseHeaders
  }

  async signUp(credentials: {
    email: string
    password: string
    options?: { data?: Record<string, unknown> } | undefined
  }): Promise<{
    data: { session: Session | null; user: User | null }
    error: SupatypeError | null
  }> {
    const body: Record<string, unknown> = {
      email: credentials.email,
      password: credentials.password,
    }
    if (credentials.options?.data !== undefined) {
      body["data"] = credentials.options.data
    }
    const res = await fetch(`${this.url}/signup`, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify(body),
    })
    return this._parseAuthResponse(res)
  }

  async signInWithPassword(credentials: {
    email: string
    password: string
  }): Promise<{
    data: { session: Session | null; user: User | null }
    error: SupatypeError | null
  }> {
    const res = await fetch(`${this.url}/token?grant_type=password`, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    })
    return this._parseAuthResponse(res)
  }

  async signInWithOAuth(opts: {
    provider: string
    options?: { redirectTo?: string | undefined } | undefined
  }): Promise<{
    data: { url: string; provider: string }
    error: SupatypeError | null
  }> {
    const url = new URL(`${this.url}/authorize`)
    url.searchParams.set("provider", opts.provider)
    if (opts.options?.redirectTo !== undefined) {
      url.searchParams.set("redirect_to", opts.options.redirectTo)
    }
    return { data: { url: url.toString(), provider: opts.provider }, error: null }
  }

  async signInWithOtp(opts: {
    email: string
    options?: { emailRedirectTo?: string | undefined } | undefined
  }): Promise<{ data: Record<string, never>; error: SupatypeError | null }> {
    const body: Record<string, unknown> = { email: opts.email, create_user: true }
    const res = await fetch(`${this.url}/otp`, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify(body),
    })
    if (res.ok) return { data: {}, error: null }
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    return {
      data: {},
      error: {
        message: String(err["error_description"] ?? err["msg"] ?? "Error"),
        status: res.status,
      },
    }
  }

  async signOut(): Promise<{ error: SupatypeError | null }> {
    if (this.currentSession !== null) {
      await fetch(`${this.url}/logout`, {
        method: "POST",
        headers: {
          ...this.baseHeaders,
          Authorization: `Bearer ${this.currentSession.accessToken}`,
        },
      }).catch(() => undefined)
    }
    this._setSession(null)
    return { error: null }
  }

  async getSession(): Promise<{
    data: { session: Session | null }
    error: SupatypeError | null
  }> {
    return { data: { session: this.currentSession }, error: null }
  }

  async getUser(): Promise<{
    data: { user: User | null }
    error: SupatypeError | null
  }> {
    if (this.currentSession === null) {
      return { data: { user: null }, error: null }
    }
    const res = await fetch(`${this.url}/user`, {
      headers: {
        ...this.baseHeaders,
        Authorization: `Bearer ${this.currentSession.accessToken}`,
      },
    })
    if (!res.ok) {
      return {
        data: { user: null },
        error: { message: "Could not get user", status: res.status },
      }
    }
    const raw = await res.json() as Record<string, unknown>
    return { data: { user: this._parseUser(raw) }, error: null }
  }

  async refreshSession(): Promise<{
    data: { session: Session | null }
    error: SupatypeError | null
  }> {
    if (this.currentSession === null) {
      return { data: { session: null }, error: { message: "No active session" } }
    }
    const res = await fetch(`${this.url}/token?grant_type=refresh_token`, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify({ refresh_token: this.currentSession.refreshToken }),
    })
    const result = await this._parseAuthResponse(res)
    return { data: { session: result.data.session }, error: result.error }
  }

  async resetPasswordForEmail(
    email: string,
    options?: { redirectTo?: string | undefined } | undefined,
  ): Promise<{ data: Record<string, never>; error: SupatypeError | null }> {
    const body: Record<string, unknown> = { email }
    if (options?.redirectTo !== undefined) {
      body["redirect_to"] = options.redirectTo
    }
    const res = await fetch(`${this.url}/recover`, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify(body),
    })
    if (res.ok) return { data: {}, error: null }
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    return {
      data: {},
      error: {
        message: String(err["error_description"] ?? err["msg"] ?? "Error"),
        status: res.status,
      },
    }
  }

  async updateUser(updates: {
    email?: string | undefined
    password?: string | undefined
    data?: Record<string, unknown> | undefined
  }): Promise<{ data: { user: User | null }; error: SupatypeError | null }> {
    if (this.currentSession === null) {
      return { data: { user: null }, error: { message: "Not authenticated" } }
    }
    const res = await fetch(`${this.url}/user`, {
      method: "PUT",
      headers: {
        ...this.baseHeaders,
        Authorization: `Bearer ${this.currentSession.accessToken}`,
      },
      body: JSON.stringify(updates),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as Record<string, unknown>
      return {
        data: { user: null },
        error: {
          message: String(err["error_description"] ?? err["msg"] ?? "Error"),
          status: res.status,
        },
      }
    }
    const raw = await res.json() as Record<string, unknown>
    return { data: { user: this._parseUser(raw) }, error: null }
  }

  onAuthStateChange(callback: AuthListener): {
    data: { subscription: { unsubscribe(): void } }
  } {
    const id = String(++this.listenerIdCounter)
    this.listeners.set(id, callback)
    // Emit current state immediately
    const event: AuthChangeEvent = this.currentSession !== null ? "SIGNED_IN" : "SIGNED_OUT"
    callback(event, this.currentSession)
    return {
      data: {
        subscription: {
          unsubscribe: () => {
            this.listeners.delete(id)
          },
        },
      },
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  _setSession(session: Session | null): void {
    const prev = this.currentSession
    this.currentSession = session
    const event: AuthChangeEvent =
      session !== null
        ? prev !== null
          ? "TOKEN_REFRESHED"
          : "SIGNED_IN"
        : "SIGNED_OUT"
    for (const cb of this.listeners.values()) {
      cb(event, session)
    }
  }

  private async _parseAuthResponse(res: Response): Promise<{
    data: { session: Session | null; user: User | null }
    error: SupatypeError | null
  }> {
    if (!res.ok) {
      const err = await res.json().catch(() => ({ msg: "Unknown error" })) as Record<string, unknown>
      return {
        data: { session: null, user: null },
        error: {
          message: String(err["error_description"] ?? err["msg"] ?? "Error"),
          status: res.status,
        },
      }
    }
    const json = await res.json() as Record<string, unknown>
    const user = this._parseUser((json["user"] ?? {}) as Record<string, unknown>)
    const session: Session = {
      accessToken: String(json["access_token"] ?? ""),
      tokenType: String(json["token_type"] ?? "bearer"),
      expiresIn: Number(json["expires_in"] ?? 3600),
      ...(json["expires_at"] !== undefined && { expiresAt: Number(json["expires_at"]) }),
      refreshToken: String(json["refresh_token"] ?? ""),
      user,
    }
    this._setSession(session)
    return { data: { session, user }, error: null }
  }

  private _parseUser(raw: Record<string, unknown>): User {
    return {
      id: String(raw["id"] ?? ""),
      ...(raw["email"] !== undefined && { email: String(raw["email"]) }),
      ...(raw["phone"] !== undefined && { phone: String(raw["phone"]) }),
      ...(raw["role"] !== undefined && { role: String(raw["role"]) }),
      appMetadata: (raw["app_metadata"] ?? {}) as Record<string, unknown>,
      userMetadata: (raw["user_metadata"] ?? {}) as Record<string, unknown>,
      createdAt: String(raw["created_at"] ?? ""),
      updatedAt: String(raw["updated_at"] ?? ""),
    }
  }
}
