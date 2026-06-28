import type {
  AuthChangeEvent,
  AuthMFAChallengeResponse,
  AuthMFAEnrollResponse,
  AuthMFAListFactorsResponse,
  Factor,
  OtpType,
  Session,
  SupatypeError,
  User,
} from "./types.js"

type AuthListener = (event: AuthChangeEvent, session: Session | null) => void

interface AuthStorageAdapter {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface AuthClientOptions {
  initialSession?: Session | undefined
  persistSession?: boolean | undefined
  storageKey?: string | undefined
  cookiePrefix?: string | undefined
}

const DEFAULT_STORAGE_KEY = "supatype.auth.session"
const DEFAULT_COOKIE_PREFIX = "st"
const DEBUG_AUTH = typeof process !== "undefined" && process.env["NEXT_PUBLIC_SUPATYPE_DEBUG_AUTH"] === "1"

export class AuthClient {
  private readonly url: string
  private readonly baseHeaders: Record<string, string>
  private currentSession: Session | null = null
  private readonly listeners = new Map<string, AuthListener>()
  private listenerIdCounter = 0
  private readonly persistSession: boolean
  private readonly storageKey: string
  private readonly cookieName: string
  private readonly storage: AuthStorageAdapter | null
  /** Pending auto-refresh timer; refreshes the access token shortly before it expires. */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  /** Dedupes concurrent refresh attempts (getSession + auto-refresh). */
  private refreshInFlight: Promise<void> | null = null

  constructor(url: string, baseHeaders: Record<string, string>, opts: AuthClientOptions = {}) {
    this.url = url
    this.baseHeaders = baseHeaders
    this.persistSession = opts.persistSession ?? true
    this.storageKey = opts.storageKey ?? DEFAULT_STORAGE_KEY
    const cookiePrefix = opts.cookiePrefix ?? DEFAULT_COOKIE_PREFIX
    this.cookieName = `${cookiePrefix}-auth-token`
    this.storage = this.getBrowserStorage()

    if (opts.initialSession !== undefined) {
      this.currentSession = opts.initialSession
      if (DEBUG_AUTH) {
        console.debug("[supatype:auth] constructor initialSession provided", {
          hasSession: true,
          userId: opts.initialSession.user.id,
        })
      }
    } else if (this.persistSession) {
      this.currentSession = this.loadPersistedSession()
      if (DEBUG_AUTH) {
        console.debug("[supatype:auth] constructor loaded persisted session", {
          hasSession: this.currentSession !== null,
          userId: this.currentSession?.user.id ?? null,
          storageKey: this.storageKey,
          cookieName: this.cookieName,
        })
      }
    }
    // Keep the access token fresh while the app is open (and refresh immediately
    // if a persisted session loaded already expired).
    this.scheduleAutoRefresh()
    if (this.currentSession !== null && this.isAccessTokenExpired(this.currentSession)) {
      void this.ensureValidSession()
    }
  }

  /** Milliseconds since epoch when the access token expires (with optional skew). */
  private sessionExpiresAtMs(session: Session): number | null {
    if (session.expiresAt !== undefined) return session.expiresAt * 1000
    const exp = this.jwtExpMs(session.accessToken)
    if (exp !== null) return exp
    return null
  }

  private jwtExpMs(accessToken: string): number | null {
    const parts = accessToken.split(".")
    if (parts.length !== 3) return null
    try {
      const payload = JSON.parse(atob(parts[1]!)) as Record<string, unknown>
      const exp = payload["exp"]
      return typeof exp === "number" ? exp * 1000 : null
    } catch {
      return null
    }
  }

  private isAccessTokenExpired(session: Session, skewMs = 0): boolean {
    const expiresAtMs = this.sessionExpiresAtMs(session)
    if (expiresAtMs === null) return false
    return Date.now() >= expiresAtMs - skewMs
  }

  /**
   * Refresh when the access token is expired. Clears the session if refresh fails
   * so callers never keep using a dead JWT (avoids stuck authenticated UI state).
   * Safe to call before REST/RPC requests; no-op when signed out or token is valid.
   */
  async ensureValidSession(): Promise<void> {
    const session = this.currentSession
    if (session === null || !this.isAccessTokenExpired(session)) return
    if (!session.refreshToken?.trim()) {
      this._setSession(null)
      return
    }
    if (this.refreshInFlight) {
      await this.refreshInFlight
      return
    }
    this.refreshInFlight = this.refreshSession()
      .then(() => undefined)
      .finally(() => {
        this.refreshInFlight = null
      })
    await this.refreshInFlight
  }

  /** Schedule a token refresh ~60s before the current session expires. */
  private scheduleAutoRefresh(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    if (typeof setTimeout === "undefined") return
    const session = this.currentSession
    if (session === null || !session.refreshToken) return

    const expiryMs = this.sessionExpiresAtMs(session)
    const delay =
      expiryMs === null
        ? Math.max(0, (session.expiresIn || 3600) * 1000 - 60_000)
        : Math.max(0, expiryMs - Date.now() - 60_000)

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.ensureValidSession()
    }, delay)
    // Avoid keeping a Node process alive for this timer (no-op in browsers).
    ;(this.refreshTimer as unknown as { unref?: () => void }).unref?.()
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

  async signInAnonymously(credentials?: {
    options?: {
      data?: Record<string, unknown> | undefined
      captchaToken?: string | undefined
    } | undefined
  }): Promise<{
    data: { session: Session | null; user: User | null }
    error: SupatypeError | null
  }> {
    const body: Record<string, unknown> = {}
    if (credentials?.options?.data !== undefined) {
      body["data"] = credentials.options.data
    }
    if (credentials?.options?.captchaToken !== undefined) {
      body["gotrue_meta_security"] = { captcha_token: credentials.options.captchaToken }
    }
    const res = await fetch(`${this.url}/signup`, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify(body),
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
    email?: string | undefined
    phone?: string | undefined
    options?: {
      emailRedirectTo?: string | undefined
      channel?: "sms" | "whatsapp" | undefined
      createUser?: boolean | undefined
    } | undefined
  }): Promise<{ data: { messageId?: string | undefined }; error: SupatypeError | null }> {
    const body: Record<string, unknown> = {
      create_user: opts.options?.createUser ?? true,
    }
    if (opts.email !== undefined) {
      body["email"] = opts.email
    }
    if (opts.phone !== undefined) {
      body["phone"] = opts.phone
      if (opts.options?.channel !== undefined) {
        body["channel"] = opts.options.channel
      }
    }
    const res = await fetch(`${this.url}/otp`, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify(body),
    })
    if (res.ok) {
      const json = await res.json().catch(() => ({})) as Record<string, unknown>
      return {
        data: {
          ...(json["message_id"] !== undefined && { messageId: String(json["message_id"]) }),
        },
        error: null,
      }
    }
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
    await this.ensureValidSession()
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
    if (!this.currentSession.refreshToken?.trim()) {
      this._setSession(null)
      return { data: { session: null }, error: { message: "No refresh token" } }
    }
    try {
      const res = await fetch(`${this.url}/token?grant_type=refresh_token`, {
        method: "POST",
        headers: this.baseHeaders,
        body: JSON.stringify({ refresh_token: this.currentSession.refreshToken }),
      })
      if (!res.ok) {
        const error = await this._parseError(res)
        this._setSession(null)
        return { data: { session: null }, error }
      }
      return await this._parseAuthResponse(res)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Refresh failed"
      this._setSession(null)
      return { data: { session: null }, error: { message } }
    }
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

  /**
   * Verify an OTP token received via email or phone.
   * Completes email confirmation, magic link, recovery, or phone OTP flows.
   */
  async verifyOtp(params: {
    token: string
    type: OtpType
    email?: string | undefined
    phone?: string | undefined
    tokenHash?: string | undefined
  }): Promise<{
    data: { session: Session | null; user: User | null }
    error: SupatypeError | null
  }> {
    const body: Record<string, unknown> = {
      type: params.type,
    }
    if (params.tokenHash !== undefined) {
      body["token_hash"] = params.tokenHash
    } else {
      body["token"] = params.token
      if (params.email !== undefined) body["email"] = params.email
      if (params.phone !== undefined) body["phone"] = params.phone
    }
    const res = await fetch(`${this.url}/verify`, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify(body),
    })
    return this._parseAuthResponse(res)
  }

  /**
   * Sign in with an ID token from an external provider (e.g. Google One Tap).
   * Uses the token grant with id_token grant type.
   */
  async signInWithIdToken(credentials: {
    provider: "google" | "apple" | string
    token: string
    nonce?: string | undefined
  }): Promise<{
    data: { session: Session | null; user: User | null }
    error: SupatypeError | null
  }> {
    const body: Record<string, unknown> = {
      provider: credentials.provider,
      id_token: credentials.token,
    }
    if (credentials.nonce !== undefined) {
      body["nonce"] = credentials.nonce
    }
    const res = await fetch(`${this.url}/token?grant_type=id_token`, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify(body),
    })
    return this._parseAuthResponse(res)
  }

  /**
   * Resend an OTP or confirmation email/SMS.
   */
  async resend(params: {
    type: "signup" | "sms" | "phone_change" | "email_change"
    email?: string | undefined
    phone?: string | undefined
  }): Promise<{ data: { messageId?: string | undefined }; error: SupatypeError | null }> {
    const body: Record<string, unknown> = { type: params.type }
    if (params.email !== undefined) body["email"] = params.email
    if (params.phone !== undefined) body["phone"] = params.phone
    const res = await fetch(`${this.url}/resend`, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify(body),
    })
    if (res.ok) {
      const json = await res.json().catch(() => ({})) as Record<string, unknown>
      return {
        data: {
          ...(json["message_id"] !== undefined && { messageId: String(json["message_id"]) }),
        },
        error: null,
      }
    }
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    return {
      data: {},
      error: {
        message: String(err["error_description"] ?? err["msg"] ?? "Error"),
        status: res.status,
      },
    }
  }

  // ─── MFA ──────────────────────────────────────────────────────────────────────

  /**
   * Multi-Factor Authentication namespace.
   * Provides methods for enrolling, challenging, and verifying MFA factors.
   */
  get mfa() {
    return {
      /**
       * Enroll a new MFA factor (TOTP or Phone).
       * Returns the factor ID and, for TOTP, the QR code and secret.
       */
      enroll: async (params: {
        factorType: "totp" | "phone"
        friendlyName?: string | undefined
        issuer?: string | undefined
        phone?: string | undefined
      }): Promise<{
        data: AuthMFAEnrollResponse | null
        error: SupatypeError | null
      }> => {
        if (this.currentSession === null) {
          return { data: null, error: { message: "Not authenticated" } }
        }
        const body: Record<string, unknown> = {
          factor_type: params.factorType,
        }
        if (params.friendlyName !== undefined) body["friendly_name"] = params.friendlyName
        if (params.issuer !== undefined) body["issuer"] = params.issuer
        if (params.phone !== undefined) body["phone"] = params.phone
        const res = await fetch(`${this.url}/factors`, {
          method: "POST",
          headers: {
            ...this.baseHeaders,
            Authorization: `Bearer ${this.currentSession.accessToken}`,
          },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          return { data: null, error: await this._parseError(res) }
        }
        const json = await res.json() as Record<string, unknown>
        const data: AuthMFAEnrollResponse = {
          id: String(json["id"] ?? ""),
          type: String(json["type"] ?? ""),
          friendlyName: String(json["friendly_name"] ?? ""),
          ...(json["totp"] !== undefined && {
            totp: {
              qrCode: String((json["totp"] as Record<string, unknown>)["qr_code"] ?? ""),
              secret: String((json["totp"] as Record<string, unknown>)["secret"] ?? ""),
              uri: String((json["totp"] as Record<string, unknown>)["uri"] ?? ""),
            },
          }),
          ...(json["phone"] !== undefined && { phone: String(json["phone"]) }),
        }
        return { data, error: null }
      },

      /**
       * Create a challenge for an enrolled MFA factor.
       * For TOTP, this simply creates a challenge ID. For Phone, it sends an SMS.
       */
      challenge: async (params: {
        factorId: string
        channel?: "sms" | "whatsapp" | undefined
      }): Promise<{
        data: AuthMFAChallengeResponse | null
        error: SupatypeError | null
      }> => {
        if (this.currentSession === null) {
          return { data: null, error: { message: "Not authenticated" } }
        }
        const body: Record<string, unknown> = {}
        if (params.channel !== undefined) body["channel"] = params.channel
        const res = await fetch(
          `${this.url}/factors/${params.factorId}/challenge`,
          {
            method: "POST",
            headers: {
              ...this.baseHeaders,
              Authorization: `Bearer ${this.currentSession.accessToken}`,
            },
            body: JSON.stringify(body),
          },
        )
        if (!res.ok) {
          return { data: null, error: await this._parseError(res) }
        }
        const json = await res.json() as Record<string, unknown>
        return {
          data: {
            id: String(json["id"] ?? ""),
            type: String(json["type"] ?? ""),
            expiresAt: Number(json["expires_at"] ?? 0),
          },
          error: null,
        }
      },

      /**
       * Verify an MFA challenge with a TOTP code or phone OTP.
       * On success, elevates the session to AAL2 and returns new tokens.
       */
      verify: async (params: {
        factorId: string
        challengeId: string
        code: string
      }): Promise<{
        data: { session: Session | null; user: User | null }
        error: SupatypeError | null
      }> => {
        if (this.currentSession === null) {
          return {
            data: { session: null, user: null },
            error: { message: "Not authenticated" },
          }
        }
        const res = await fetch(
          `${this.url}/factors/${params.factorId}/verify`,
          {
            method: "POST",
            headers: {
              ...this.baseHeaders,
              Authorization: `Bearer ${this.currentSession.accessToken}`,
            },
            body: JSON.stringify({
              challenge_id: params.challengeId,
              code: params.code,
            }),
          },
        )
        const result = await this._parseAuthResponse(res)
        if (result.data.session !== null) {
          this._emitEvent("MFA_CHALLENGE_VERIFIED", result.data.session)
        }
        return result
      },

      /**
       * Convenience method: create a challenge and immediately verify it.
       */
      challengeAndVerify: async (params: {
        factorId: string
        code: string
      }): Promise<{
        data: { session: Session | null; user: User | null }
        error: SupatypeError | null
      }> => {
        const challengeResult = await this.mfa.challenge({
          factorId: params.factorId,
        })
        if (challengeResult.error !== null || challengeResult.data === null) {
          return {
            data: { session: null, user: null },
            error: challengeResult.error,
          }
        }
        return this.mfa.verify({
          factorId: params.factorId,
          challengeId: challengeResult.data.id,
          code: params.code,
        })
      },

      /**
       * Unenroll (remove) an MFA factor. Requires AAL2 for verified factors.
       */
      unenroll: async (params: {
        factorId: string
      }): Promise<{
        data: { id: string } | null
        error: SupatypeError | null
      }> => {
        if (this.currentSession === null) {
          return { data: null, error: { message: "Not authenticated" } }
        }
        const res = await fetch(
          `${this.url}/factors/${params.factorId}`,
          {
            method: "DELETE",
            headers: {
              ...this.baseHeaders,
              Authorization: `Bearer ${this.currentSession.accessToken}`,
            },
          },
        )
        if (!res.ok) {
          return { data: null, error: await this._parseError(res) }
        }
        const json = await res.json() as Record<string, unknown>
        return { data: { id: String(json["id"] ?? "") }, error: null }
      },

      /**
       * List the user's enrolled MFA factors, categorized by type.
       */
      listFactors: async (): Promise<{
        data: AuthMFAListFactorsResponse | null
        error: SupatypeError | null
      }> => {
        const userResult = await this.getUser()
        if (userResult.error !== null || userResult.data.user === null) {
          return { data: null, error: userResult.error ?? { message: "Could not get user" } }
        }
        const allFactors: Factor[] = userResult.data.user.factors ?? []
        const verifiedFactors = allFactors.filter((f) => f.status === "verified")
        return {
          data: {
            all: allFactors,
            totp: verifiedFactors.filter((f) => f.factorType === "totp"),
            phone: verifiedFactors.filter((f) => f.factorType === "phone"),
          },
          error: null,
        }
      },

      /**
       * Returns the current Authenticator Assurance Level (AAL) for the session.
       * aal1 = password/otp only; aal2 = MFA verified.
       */
      getAuthenticatorAssuranceLevel: async (): Promise<{
        data: {
          currentLevel: "aal1" | "aal2" | null
          nextLevel: "aal1" | "aal2" | null
          currentAuthenticationMethods: string[]
        } | null
        error: SupatypeError | null
      }> => {
        if (this.currentSession === null) {
          return { data: null, error: { message: "Not authenticated" } }
        }
        // Decode the JWT payload to read the aal and amr claims
        const parts = this.currentSession.accessToken.split(".")
        if (parts.length !== 3) {
          return { data: null, error: { message: "Invalid access token format" } }
        }
        try {
          const payload = JSON.parse(atob(parts[1]!)) as Record<string, unknown>
          const currentLevel = (payload["aal"] as "aal1" | "aal2" | undefined) ?? null
          const amr = (payload["amr"] as Array<{ method: string }> | undefined) ?? []
          const methods = amr.map((entry) => entry.method)

          // Determine next level: if user has verified factors, next could be aal2
          const userResult = await this.getUser()
          const factors = userResult.data?.user?.factors ?? []
          const hasVerifiedFactors = factors.some((f) => f.status === "verified")
          const nextLevel = hasVerifiedFactors ? "aal2" : "aal1"

          return {
            data: {
              currentLevel,
              nextLevel: nextLevel as "aal1" | "aal2",
              currentAuthenticationMethods: methods,
            },
            error: null,
          }
        } catch {
          return { data: null, error: { message: "Failed to decode access token" } }
        }
      },
    }
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

  /** Returns the current session's access token, or null when signed out. */
  get currentAccessToken(): string | null {
    return this.currentSession?.accessToken ?? null
  }

  private getBrowserStorage(): AuthStorageAdapter | null {
    if (typeof window === "undefined") return null
    try {
      return window.localStorage
    } catch {
      return null
    }
  }

  private loadPersistedSession(): Session | null {
    const fromStorage = this.storage?.getItem(this.storageKey) ?? null
    if (fromStorage !== null) {
      const parsed = this.parsePersistedSession(fromStorage)
      if (DEBUG_AUTH) {
        console.debug("[supatype:auth] loadPersistedSession localStorage", {
          found: true,
          parsed: parsed !== null,
        })
      }
      if (parsed !== null) return parsed
    }
    if (typeof document !== "undefined") {
      const fromCookie = this.readCookie(this.cookieName)
      if (fromCookie !== null) {
        const parsed = this.parsePersistedSession(fromCookie)
        if (DEBUG_AUTH) {
          console.debug("[supatype:auth] loadPersistedSession cookie", {
            found: true,
            parsed: parsed !== null,
            cookieName: this.cookieName,
          })
        }
        if (parsed !== null) return parsed
      }
    }
    return null
  }

  private parsePersistedSession(raw: string): Session | null {
    try {
      const parsed = JSON.parse(raw) as unknown
      return this.normalizePersistedSession(parsed)
    } catch {
      return null
    }
  }

  private normalizePersistedSession(raw: unknown): Session | null {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const accessToken =
      typeof r["accessToken"] === "string"
        ? r["accessToken"]
        : typeof r["access_token"] === "string"
          ? r["access_token"]
          : null
    if (accessToken === null) return null
    const refreshToken =
      typeof r["refreshToken"] === "string"
        ? r["refreshToken"]
        : typeof r["refresh_token"] === "string"
          ? r["refresh_token"]
          : ""
    const tokenType =
      typeof r["tokenType"] === "string"
        ? r["tokenType"]
        : typeof r["token_type"] === "string"
          ? r["token_type"]
          : "bearer"
    const expiresIn =
      typeof r["expiresIn"] === "number"
        ? r["expiresIn"]
        : typeof r["expires_in"] === "number"
          ? r["expires_in"]
          : 3600
    const userRaw =
      typeof r["user"] === "object" && r["user"] !== null
        ? (r["user"] as Record<string, unknown>)
        : null
    if (userRaw === null) return null
    const normalizedUserRaw: Record<string, unknown> = {
      ...userRaw,
      ...(userRaw["app_metadata"] === undefined &&
        userRaw["appMetadata"] !== undefined && { app_metadata: userRaw["appMetadata"] }),
      ...(userRaw["user_metadata"] === undefined &&
        userRaw["userMetadata"] !== undefined && { user_metadata: userRaw["userMetadata"] }),
      ...(userRaw["created_at"] === undefined &&
        userRaw["createdAt"] !== undefined && { created_at: userRaw["createdAt"] }),
      ...(userRaw["updated_at"] === undefined &&
        userRaw["updatedAt"] !== undefined && { updated_at: userRaw["updatedAt"] }),
    }
    const session: Session = {
      accessToken,
      refreshToken,
      tokenType,
      expiresIn,
      user: this._parseUser(normalizedUserRaw),
      ...(typeof r["expiresAt"] === "number"
        ? { expiresAt: r["expiresAt"] }
        : typeof r["expires_at"] === "number"
          ? { expiresAt: r["expires_at"] }
          : {}),
    }
    return session
  }

  private syncPersistedSession(session: Session | null): void {
    if (!this.persistSession) return
    const storage = this.storage
    const cookieExpires = session?.expiresAt
    if (session === null) {
      try {
        storage?.removeItem(this.storageKey)
      } catch {
        // Ignore storage write failures.
      }
      this.writeCookie(this.cookieName, "", -1)
      if (DEBUG_AUTH) {
        console.debug("[supatype:auth] cleared persisted session", {
          storageKey: this.storageKey,
          cookieName: this.cookieName,
        })
      }
      return
    }

    const json = JSON.stringify(session)
    const cookiePayload = JSON.stringify({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      token_type: session.tokenType,
      expires_in: session.expiresIn,
      ...(session.expiresAt !== undefined && { expires_at: session.expiresAt }),
      user: this.serializeUserForCookie(session.user),
    })
    try {
      storage?.setItem(this.storageKey, json)
    } catch {
      // Ignore storage write failures.
    }
    this.writeCookie(this.cookieName, cookiePayload, cookieExpires)
    if (DEBUG_AUTH) {
      console.debug("[supatype:auth] persisted session", {
        userId: session.user.id,
        storageKey: this.storageKey,
        cookieName: this.cookieName,
        hasExpiresAt: session.expiresAt !== undefined,
      })
    }
  }

  private serializeUserForCookie(user: User): Record<string, unknown> {
    return {
      id: user.id,
      ...(user.email !== undefined && { email: user.email }),
      ...(user.phone !== undefined && { phone: user.phone }),
      ...(user.role !== undefined && { role: user.role }),
      app_metadata: user.appMetadata,
      user_metadata: user.userMetadata,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
    }
  }

  private readCookie(name: string): string | null {
    if (typeof document === "undefined") return null
    const all = document.cookie ? document.cookie.split("; ") : []
    for (const item of all) {
      const idx = item.indexOf("=")
      if (idx <= 0) continue
      const key = item.slice(0, idx)
      if (key !== name) continue
      const value = item.slice(idx + 1)
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    }
    return null
  }

  private writeCookie(name: string, value: string, expiresAtSeconds?: number): void {
    if (typeof document === "undefined") return
    const secure = typeof window !== "undefined" && window.location.protocol === "https:"
    const attrs = [
      `Path=/`,
      "SameSite=Lax",
      ...(secure ? ["Secure"] : []),
    ]
    if (expiresAtSeconds !== undefined) {
      attrs.push(`Expires=${new Date(expiresAtSeconds * 1000).toUTCString()}`)
    } else if (value === "") {
      attrs.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT")
    }
    document.cookie = `${name}=${encodeURIComponent(value)}; ${attrs.join("; ")}`
  }

  _setSession(session: Session | null): void {
    const prev = this.currentSession
    this.currentSession = session
    this.syncPersistedSession(session)
    if (session !== null) {
      this.scheduleAutoRefresh()
    } else if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
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

  private _emitEvent(event: AuthChangeEvent, session: Session | null): void {
    for (const cb of this.listeners.values()) {
      cb(event, session)
    }
  }

  private async _parseError(res: Response): Promise<SupatypeError> {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    return {
      message: String(err["error_description"] ?? err["msg"] ?? err["message"] ?? "Error"),
      status: res.status,
      ...(err["error_code"] !== undefined && { code: String(err["error_code"]) }),
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
    const user: User = {
      id: String(raw["id"] ?? ""),
      ...(raw["email"] !== undefined && { email: String(raw["email"]) }),
      ...(raw["phone"] !== undefined && { phone: String(raw["phone"]) }),
      ...(raw["role"] !== undefined && { role: String(raw["role"]) }),
      ...(raw["is_anonymous"] !== undefined && { isAnonymous: Boolean(raw["is_anonymous"]) }),
      appMetadata: (raw["app_metadata"] ?? {}) as Record<string, unknown>,
      userMetadata: (raw["user_metadata"] ?? {}) as Record<string, unknown>,
      createdAt: String(raw["created_at"] ?? ""),
      updatedAt: String(raw["updated_at"] ?? ""),
    }
    if (Array.isArray(raw["identities"])) {
      user.identities = (raw["identities"] as Record<string, unknown>[]).map((i) => ({
        id: String(i["id"] ?? ""),
        userId: String(i["user_id"] ?? ""),
        identityData: (i["identity_data"] ?? {}) as Record<string, unknown>,
        identityId: String(i["identity_id"] ?? ""),
        provider: String(i["provider"] ?? ""),
        createdAt: String(i["created_at"] ?? ""),
        updatedAt: String(i["updated_at"] ?? ""),
        ...(i["last_sign_in_at"] !== undefined && { lastSignInAt: String(i["last_sign_in_at"]) }),
      }))
    }
    if (Array.isArray(raw["factors"])) {
      user.factors = (raw["factors"] as Record<string, unknown>[]).map((f) => ({
        id: String(f["id"] ?? ""),
        factorType: String(f["factor_type"] ?? "totp") as "totp" | "phone" | "webauthn",
        status: String(f["status"] ?? "unverified") as "verified" | "unverified",
        createdAt: String(f["created_at"] ?? ""),
        updatedAt: String(f["updated_at"] ?? ""),
        ...(f["friendly_name"] !== undefined && { friendlyName: String(f["friendly_name"]) }),
        ...(f["phone"] !== undefined && { phone: String(f["phone"]) }),
      }))
    }
    return user
  }
}
