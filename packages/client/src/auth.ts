import type {
  AuthChangeEvent,
  AuthFlowType,
  AuthRedirectError,
  AuthMFAChallengeResponse,
  AuthMFAEnrollResponse,
  AuthMFAListFactorsResponse,
  AuthStorage,
  Factor,
  OtpType,
  Session,
  SupatypeError,
  User,
  UserIdentity,
} from "./types.js"
import {
  createCodeChallengeS256,
  generateCodeVerifier,
  PKCE_METHOD_S256,
} from "./pkce.js"
import { plainFetch, type RequestTransport } from "./fetch-with-retry.js"
import {
  browserHref,
  carriesImplicitResult,
  cleanBrowserUrl,
  redirectParam,
  redirectParams,
} from "./auth-redirect.js"
import {
  isJsonObject,
  isNumber,
  isOneOf,
  isShape,
  isString,
  objectOrEmpty,
  readJson,
  readJsonObject,
  type Guard,
} from "./json.js"
import { decodeJwtPayload } from "./jwt.js"

export type AuthListener = (event: AuthChangeEvent, session: Session | null) => void

interface AuthClientOptions {
  initialSession?: Session | undefined
  persistSession?: boolean | undefined
  /** Refresh on a timer before the token expires, and at once when it starts expired. Default: true. */
  autoRefreshToken?: boolean | undefined
  /** Refresh an expired access token when a request or `getSession` finds it. Default: true. */
  refreshExpiredToken?: boolean | undefined
  storageKey?: string | undefined
  cookiePrefix?: string | undefined
  /** Custom session store (replaces browser localStorage/cookies when set). */
  storage?: AuthStorage | undefined
  /** How requests are sent. `createClient` passes its fetch, so `timeout` and `retry` apply here too. */
  transport?: RequestTransport | undefined
  /** Finish a sign-in carried by the page's URL on start (browser only). Default: true. */
  detectSessionInUrl?: boolean | undefined
}

const DEFAULT_STORAGE_KEY = "supatype.auth.session"
const DEFAULT_COOKIE_PREFIX = "st"
/** Storage key suffixes for the state an OAuth redirect has to survive. */
const VERIFIER_SUFFIX = "-code-verifier"
const PROVIDER_SUFFIX = "-oauth-provider"
const DEBUG_AUTH = typeof process !== "undefined" && process.env["NEXT_PUBLIC_SUPATYPE_DEBUG_AUTH"] === "1"

/**
 * The auth server's refusal as a `SupatypeError`, with its machine-readable code kept.
 *
 * Two body shapes arrive: `{ code, error_code, msg }` from the API, and the OAuth token endpoint's
 * `{ error, error_description }`, where `error` is the code. The code is what an app branches on
 * (`invalid_credentials`, `weak_password`, `email_not_confirmed`); the numeric `code` in the first
 * shape is only the HTTP status again, so it is not used. Message precedence follows supabase-js.
 */
function authErrorFromBody(body: Record<string, unknown>, status: number): SupatypeError {
  const text = (key: string): string | undefined => {
    const value = body[key]
    return typeof value === "string" && value !== "" ? value : undefined
  }
  const code = text("error_code") ?? text("error")
  const message =
    text("msg") ?? text("message") ?? text("error_description") ?? text("error") ??
    `Auth request failed (HTTP ${status})`
  return { message, status, ...(code !== undefined && { code }) }
}

/** The assurance levels the client reports; the server's unused `aal3` reads as unknown. */
const isAal = isOneOf(["aal1", "aal2"])
/** One entry of the JWT's `amr` claim: how the session was authenticated, and when. */
const isAmrEntry = isShape({ method: isString })
/** The factor types and states supatype-auth defines (internal/auth/models/factor.go). */
const isFactorType = isOneOf(["totp", "phone", "webauthn"])
const isFactorStatus = isOneOf(["verified", "unverified"])

/** The assurance level and the authentication methods an access token's claims carry. */
function assuranceClaims(claims: Record<string, unknown>): {
  currentLevel: "aal1" | "aal2" | null
  methods: string[]
} {
  const aal = claims["aal"]
  const amr = claims["amr"]
  return {
    currentLevel: isAal(aal) ? aal : null,
    methods: Array.isArray(amr) ? amr.filter(isAmrEntry).map((entry) => entry.method) : [],
  }
}

/** The value under `first` when the guard accepts it, else the one under `second`, else undefined. */
function eitherKey<T>(
  body: Record<string, unknown>,
  first: string,
  second: string,
  guard: Guard<T>,
): T | undefined {
  const a = body[first]
  if (guard(a)) return a
  const b = body[second]
  return guard(b) ? b : undefined
}

/** A stored user with its camelCase keys copied to the snake_case ones `_parseUser` reads. */
function snakeCaseUser(user: Record<string, unknown>): Record<string, unknown> {
  const aliases = [
    ["app_metadata", "appMetadata"],
    ["user_metadata", "userMetadata"],
    ["created_at", "createdAt"],
    ["updated_at", "updatedAt"],
  ] as const
  const normalized = { ...user }
  for (const [snake, camel] of aliases) {
    if (user[snake] === undefined && user[camel] !== undefined) normalized[snake] = user[camel]
  }
  return normalized
}

export class AuthClient {
  private readonly url: string
  private readonly baseHeaders: Record<string, string>
  private currentSession: Session | null = null
  private readonly listeners = new Map<string, AuthListener>()
  private listenerIdCounter = 0
  private readonly persistSession: boolean
  /** False leaves every refresh to `ensureValidSession`, which each request calls first. */
  private readonly autoRefreshToken: boolean
  /** False makes `ensureValidSession` leave an expired session as it is, for the server to refuse. */
  private readonly refreshExpiredToken: boolean
  private readonly storageKey: string
  private readonly cookieName: string
  private readonly storage: AuthStorage | null
  /** The client's fetch, with its timeout; only reads are retried. */
  private readonly send: RequestTransport
  /** When true, session is also mirrored to document.cookie (browser default path only). */
  private readonly useCookies: boolean
  /** Resolves when async storage hydration and any sign-in carried by the page's URL complete. */
  private readonly ready: Promise<void>
  /** What `ready` settles with: the refusal the page's URL reported, if any. */
  private readonly initialized: Promise<{ error: AuthRedirectError | null }>
  /** Pending auto-refresh timer; refreshes the access token shortly before it expires. */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  /** Dedupes concurrent refresh attempts (getSession + auto-refresh). */
  private refreshInFlight: Promise<void> | null = null
  /** In-memory PKCE code_verifier for the in-flight OAuth / OTP redirect. */
  private codeVerifier: string | null = null

  constructor(url: string, baseHeaders: Record<string, string>, opts: AuthClientOptions = {}) {
    this.url = url
    this.baseHeaders = baseHeaders
    this.persistSession = opts.persistSession ?? true
    this.autoRefreshToken = opts.autoRefreshToken ?? true
    this.refreshExpiredToken = opts.refreshExpiredToken ?? true
    this.storageKey = opts.storageKey ?? DEFAULT_STORAGE_KEY
    const cookiePrefix = opts.cookiePrefix ?? DEFAULT_COOKIE_PREFIX
    this.cookieName = `${cookiePrefix}-auth-token`
    this.useCookies = opts.storage === undefined
    this.storage = opts.storage ?? this.getBrowserStorage()
    this.send = opts.transport ?? plainFetch

    const hydrated = this.loadInitialSession(opts)
    this.initialized = opts.detectSessionInUrl === false
      ? hydrated.then(() => ({ error: null }))
      : hydrated.then(() => this.completeRedirect())
    this.ready = this.initialized.then(() => undefined)
    // Keep the access token fresh while the app is open (and refresh immediately
    // if a persisted session loaded already expired).
    this.scheduleAutoRefresh()
    if (this.autoRefreshToken && this.currentSession !== null && this.isAccessTokenExpired(this.currentSession)) {
      void this.ensureValidSession()
    }
  }

  /** The session the client starts with: the one passed in, else the persisted one. */
  private loadInitialSession(opts: AuthClientOptions): Promise<void> {
    if (opts.initialSession !== undefined) {
      this.currentSession = opts.initialSession
      if (DEBUG_AUTH) {
        console.debug("[supatype:auth] constructor initialSession provided", {
          hasSession: true,
          userId: opts.initialSession.user.id,
        })
      }
      return Promise.resolve()
    }
    if (!this.persistSession) return Promise.resolve()
    if (opts.storage !== undefined) return this.hydrateFromStorage()
    this.currentSession = this.loadPersistedSession()
    if (DEBUG_AUTH) {
      console.debug("[supatype:auth] constructor loaded persisted session", {
        hasSession: this.currentSession !== null,
        userId: this.currentSession?.user.id ?? null,
        storageKey: this.storageKey,
        cookieName: this.cookieName,
      })
    }
    return Promise.resolve()
  }

  /** Resolves when the client has its starting session (storage hydrated, any URL sign-in done). */
  whenReady(): Promise<void> {
    return this.ready
  }

  /**
   * Wait for the client's start, and learn whether a sign-in in the page's URL was refused.
   *
   * The same shape as supabase-js's `initialize()`. A refused OAuth sign-in comes back as
   * `?error=...&error_description=...`; this is where an app (or `useAuth`) reads it.
   */
  initialize(): Promise<{ error: AuthRedirectError | null }> {
    return this.initialized
  }

  /**
   * Finish the sign-in the page's URL carries, as supabase-js's `detectSessionInUrl` does.
   *
   * Whatever session was stored is set aside first, so a new sign-in is announced as `SIGNED_IN`
   * and a refused one leaves the browser signed out, as supabase-js does after a failed attempt.
   */
  private async completeRedirect(): Promise<{ error: AuthRedirectError | null }> {
    const href = browserHref()
    if (href === null || !(await this.isAuthRedirect(href))) return { error: null }
    const provider = await this.takeFlowItem(PROVIDER_SUFFIX)
    this.currentSession = null
    const { error } = await this.getSessionFromUrl(href).catch((err: unknown) => ({
      error: { message: err instanceof Error ? err.message : "Could not finish the sign-in" },
    }))
    cleanBrowserUrl(href)
    if (error === null) return { error: null }
    this._setSession(null)
    return { error: { ...error, ...(provider !== null && { provider }) } }
  }

  /** A URL with tokens or a refusal, or with a `code` for a PKCE flow this client started. */
  private async isAuthRedirect(href: string): Promise<boolean> {
    const params = redirectParams(href)
    if (params === null) return false
    if (carriesImplicitResult(params)) return true
    return redirectParam(params, "code") !== null && (await this.readCodeVerifier()) !== null
  }

  private async hydrateFromStorage(): Promise<void> {
    try {
      const session = await this.loadPersistedSessionAsync()
      if (session === null) return
      this.currentSession = session
      this.scheduleAutoRefresh()
      if (this.isAccessTokenExpired(session)) {
        await this.ensureValidSessionInternal()
      }
      this._emitEvent("SIGNED_IN", session)
      if (DEBUG_AUTH) {
        console.debug("[supatype:auth] hydrated session from custom storage", {
          userId: session.user.id,
          storageKey: this.storageKey,
        })
      }
    } catch {
      // Corrupt or unavailable storage, treat as signed out.
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
    const exp = decodeJwtPayload(parts[1]!)?.["exp"]
    return typeof exp === "number" ? exp * 1000 : null
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
    await this.ready
    return this.ensureValidSessionInternal()
  }

  private async ensureValidSessionInternal(): Promise<void> {
    const session = this.currentSession
    if (session === null || !this.isAccessTokenExpired(session)) return
    // Sent as it is: a refresh nobody can store spends a refresh token someone else holds.
    if (!this.refreshExpiredToken) return
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
    if (!this.autoRefreshToken || typeof setTimeout === "undefined") return
    const session = this.currentSession
    if (session === null || !session.refreshToken) return

    const expiryMs = this.sessionExpiresAtMs(session)
    const delay =
      expiryMs === null
        ? Math.max(0, (session.expiresIn || 3600) * 1000 - 60_000)
        : Math.max(0, expiryMs - Date.now() - 60_000)

    const timer = setTimeout(() => {
      this.refreshTimer = null
      void this.ensureValidSession()
    }, delay)
    this.refreshTimer = timer
    // Avoid keeping a Node process alive for this timer. A browser's timer is a number: nothing to do.
    if (typeof timer === "object" && "unref" in timer) timer.unref()
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
    const res = await this.send(`${this.url}/signup`, {
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
    const res = await this.send(`${this.url}/token?grant_type=password`, {
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
      body["supatype_meta_security"] = { captcha_token: credentials.options.captchaToken }
    }
    const res = await this.send(`${this.url}/signup`, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify(body),
    })
    return this._parseAuthResponse(res)
  }

  /**
   * An auth endpoint, carrying the caller's redirect as `redirect_to` in the query string. The
   * server reads it from there (or a header) and never from a JSON body, so a redirect sent in the
   * body is dropped in silence and the email links to SITE_URL instead.
   */
  private endpoint(path: string, redirectTo: string | undefined): URL {
    const url = new URL(`${this.url}${path}`)
    if (redirectTo !== undefined) url.searchParams.set("redirect_to", redirectTo)
    return url
  }

  async signInWithOAuth(opts: {
    provider: string
    options?: {
      redirectTo?: string | undefined
      /** Default: `implicit` (web-compatible). Pass `pkce` for mobile / RN. */
      flowType?: AuthFlowType | undefined
      scopes?: string | undefined
      /**
       * Extra `/authorize` query parameters, sent as given. The flow's own (`provider`,
       * `redirect_to`, `scopes`, the PKCE challenge) are set after these and cannot be replaced.
       */
      queryParams?: Record<string, string> | undefined
    } | undefined
  }): Promise<{
    data: { url: string; provider: string }
    error: SupatypeError | null
  }> {
    // The server answers /authorize for a disabled provider with a bare JSON 400, which a browser
    // navigating there shows as raw text; asking first lets the caller show a message instead.
    if (await this.providerDisabled(opts.provider)) {
      const message = `Sign-in with ${opts.provider} is not enabled for this project.`
      return { data: { url: "", provider: opts.provider }, error: { message, status: 400, code: "provider_disabled" } }
    }
    await this.writeFlowItem(PROVIDER_SUFFIX, opts.provider)
    const url = this.endpoint("/authorize", opts.options?.redirectTo)
    for (const [key, value] of Object.entries(opts.options?.queryParams ?? {})) {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value)
    }
    url.searchParams.set("provider", opts.provider)
    if (opts.options?.scopes !== undefined) {
      url.searchParams.set("scopes", opts.options.scopes)
    }
    const flowType = opts.options?.flowType ?? "implicit"
    if (flowType === "pkce") {
      await this.beginPkce()
      url.searchParams.set("code_challenge", createCodeChallengeS256(this.codeVerifier!))
      url.searchParams.set("code_challenge_method", PKCE_METHOD_S256)
    }
    return { data: { url: url.toString(), provider: opts.provider }, error: null }
  }

  /**
   * True only when the server's `/settings` list the provider as off. A provider they do not list
   * (a `custom:` one) or settings that cannot be read leave the decision to `/authorize`. Looked up
   * in lower case, as `/authorize` resolves it, so `GitHub` is refused exactly when `github` is.
   */
  private async providerDisabled(provider: string): Promise<boolean> {
    try {
      const res = await this.send(`${this.url}/settings`, { headers: this.baseHeaders })
      if (!res.ok) return false
      const external = objectOrEmpty((await readJsonObject(res))["external"])
      return external[provider.toLowerCase()] === false
    } catch {
      return false
    }
  }

  /**
   * Apply tokens from an OAuth / deep-link redirect (implicit grant) or restore a session.
   * Fetches `/user` to hydrate the user object, then persists via the configured storage.
   */
  async setSession(params: {
    accessToken: string
    refreshToken: string
  }): Promise<{
    data: { session: Session | null; user: User | null }
    error: SupatypeError | null
  }> {
    const res = await this.send(`${this.url}/user`, {
      headers: {
        ...this.baseHeaders,
        Authorization: `Bearer ${params.accessToken}`,
      },
    })
    if (!res.ok) {
      return {
        data: { session: null, user: null },
        error: await this._parseError(res),
      }
    }
    const user = await this._readUser(res)
    const session: Session = {
      accessToken: params.accessToken,
      refreshToken: params.refreshToken,
      tokenType: "bearer",
      expiresIn: 3600,
      user,
    }
    const exp = this.decodeJwtExp(params.accessToken)
    if (exp !== null) {
      session.expiresAt = exp
      session.expiresIn = Math.max(0, exp - Math.floor(Date.now() / 1000))
    }
    this._setSession(session)
    return { data: { session, user }, error: null }
  }

  /**
   * Exchange a PKCE auth code for a session (`POST /token?grant_type=pkce`).
   * Requires a prior `signInWithOAuth({ options: { flowType: "pkce" } })` (or OTP with PKCE)
   * so the matching `code_verifier` is available in memory / storage.
   */
  async exchangeCodeForSession(authCode: string): Promise<{
    data: { session: Session | null; user: User | null }
    error: SupatypeError | null
  }> {
    const verifier = await this.readCodeVerifier()
    if (verifier === null) {
      return {
        data: { session: null, user: null },
        error: {
          message: "Missing PKCE code_verifier. Start OAuth with flowType: \"pkce\" first.",
          status: 400,
        },
      }
    }
    const res = await this.send(`${this.url}/token?grant_type=pkce`, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify({
        auth_code: authCode,
        code_verifier: verifier,
      }),
    })
    await this.clearCodeVerifier()
    return this._parseAuthResponse(res)
  }

  /**
   * Parse an OAuth / magic-link redirect URL and establish a session.
   * Supports PKCE (`?code=`) and implicit (`#access_token=` / query tokens).
   */
  async getSessionFromUrl(url: string): Promise<{
    data: { session: Session | null; user: User | null }
    error: SupatypeError | null
  }> {
    const params = redirectParams(url)
    if (params === null) {
      return {
        data: { session: null, user: null },
        error: { message: `Invalid redirect URL: ${url}`, status: 400 },
      }
    }
    const { query, fragment: hashParams } = params

    // A refused link comes back with the same fields as a refused request, in the URL instead.
    const redirectError = { ...Object.fromEntries(hashParams), ...Object.fromEntries(query) }
    if (redirectError["error_description"] || redirectError["error"]) {
      return { data: { session: null, user: null }, error: authErrorFromBody(redirectError, 400) }
    }

    // The auth server marks the link it sent with `type`; a recovery link signs the user in so they
    // can choose a new password, and the app needs to know that is why they arrived.
    const recovery = (hashParams.get("type") ?? query.get("type")) === "recovery"
    return this.announceRecovery(await this.sessionFromRedirect(query, hashParams), recovery)
  }

  /** The session a redirect carries: a PKCE code to exchange, or implicit-grant tokens. */
  private async sessionFromRedirect(
    query: URLSearchParams,
    hashParams: URLSearchParams,
  ): Promise<{
    data: { session: Session | null; user: User | null }
    error: SupatypeError | null
  }> {
    const code = query.get("code") ?? hashParams.get("code")
    if (code !== null && code !== "") {
      return this.exchangeCodeForSession(code)
    }

    const accessToken =
      hashParams.get("access_token") ?? query.get("access_token")
    const refreshToken =
      hashParams.get("refresh_token") ?? query.get("refresh_token")
    if (accessToken !== null && accessToken !== "" && refreshToken !== null && refreshToken !== "") {
      return this.setSession({ accessToken, refreshToken })
    }

    return {
      data: { session: null, user: null },
      error: {
        message: "No auth code or tokens found in redirect URL",
        status: 400,
      },
    }
  }

  /**
   * Emit `PASSWORD_RECOVERY` once a recovery link or code has produced a session.
   *
   * After the `SIGNED_IN` that establishing the session already emitted, as `MFA_CHALLENGE_VERIFIED`
   * follows it, so a listener keyed on sign-in still sees one and a reset page can key on this.
   */
  private announceRecovery<T extends { data: { session: Session | null }; error: SupatypeError | null }>(
    result: T,
    recovery: boolean,
  ): T {
    if (recovery && result.error === null && result.data.session !== null) {
      this._emitEvent("PASSWORD_RECOVERY", result.data.session)
    }
    return result
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
    const res = await this.send(this.endpoint("/otp", opts.options?.emailRedirectTo).toString(), {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify(body),
    })
    if (res.ok) {
      const json = await readJsonObject(res)
      return {
        data: {
          ...(json["message_id"] !== undefined && { messageId: String(json["message_id"]) }),
        },
        error: null,
      }
    }
    return { data: {}, error: await this._parseError(res) }
  }

  async signOut(): Promise<{ error: SupatypeError | null }> {
    if (this.currentSession !== null) {
      await this.send(`${this.url}/logout`, {
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
    await this.ready
    await this.ensureValidSessionInternal()
    return { data: { session: this.currentSession }, error: null }
  }

  async getUser(): Promise<{
    data: { user: User | null }
    error: SupatypeError | null
  }> {
    if (this.currentSession === null) {
      return { data: { user: null }, error: null }
    }
    const res = await this.send(`${this.url}/user`, {
      headers: {
        ...this.baseHeaders,
        Authorization: `Bearer ${this.currentSession.accessToken}`,
      },
    })
    if (!res.ok) {
      return { data: { user: null }, error: await this._parseError(res) }
    }
    return { data: { user: await this._readUser(res) }, error: null }
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
      const res = await this.send(`${this.url}/token?grant_type=refresh_token`, {
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
    const res = await this.send(this.endpoint("/recover", options?.redirectTo).toString(), {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify({ email }),
    })
    if (res.ok) return { data: {}, error: null }
    return { data: {}, error: await this._parseError(res) }
  }

  async updateUser(updates: {
    email?: string | undefined
    password?: string | undefined
    data?: Record<string, unknown> | undefined
  }): Promise<{ data: { user: User | null }; error: SupatypeError | null }> {
    if (this.currentSession === null) {
      return { data: { user: null }, error: { message: "Not authenticated" } }
    }
    const res = await this.send(`${this.url}/user`, {
      method: "PUT",
      headers: {
        ...this.baseHeaders,
        Authorization: `Bearer ${this.currentSession.accessToken}`,
      },
      body: JSON.stringify(updates),
    })
    if (!res.ok) {
      return { data: { user: null }, error: await this._parseError(res) }
    }
    const user = await this._readUser(res)
    this.applyUpdatedUser(user)
    return { data: { user }, error: null }
  }

  /**
   * Put the server's updated user on the session, persist it, and tell listeners.
   *
   * The tokens are unchanged, so this neither reschedules the refresh nor emits `TOKEN_REFRESHED`;
   * without it the session kept the old email and metadata until the next refresh.
   */
  private applyUpdatedUser(user: User): void {
    if (this.currentSession === null) return
    const session: Session = { ...this.currentSession, user }
    this.currentSession = session
    this.syncPersistedSession(session)
    this._emitEvent("USER_UPDATED", session)
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
    const res = await this.send(`${this.url}/verify`, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify(body),
    })
    return this.announceRecovery(await this._parseAuthResponse(res), params.type === "recovery")
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
    const res = await this.send(`${this.url}/token?grant_type=id_token`, {
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
    const res = await this.send(`${this.url}/resend`, {
      method: "POST",
      headers: this.baseHeaders,
      body: JSON.stringify(body),
    })
    if (res.ok) {
      const json = await readJsonObject(res)
      return {
        data: {
          ...(json["message_id"] !== undefined && { messageId: String(json["message_id"]) }),
        },
        error: null,
      }
    }
    return { data: {}, error: await this._parseError(res) }
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
        const res = await this.send(`${this.url}/factors`, {
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
        const json = await readJson(res, isJsonObject)
        const totp = json["totp"]
        const data: AuthMFAEnrollResponse = {
          id: String(json["id"] ?? ""),
          type: String(json["type"] ?? ""),
          friendlyName: String(json["friendly_name"] ?? ""),
          ...(isJsonObject(totp) && {
            totp: {
              qrCode: String(totp["qr_code"] ?? ""),
              secret: String(totp["secret"] ?? ""),
              uri: String(totp["uri"] ?? ""),
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
        const res = await this.send(
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
        const json = await readJson(res, isJsonObject)
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
        const res = await this.send(
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
        const res = await this.send(
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
        const json = await readJson(res, isJsonObject)
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
        const payload = decodeJwtPayload(parts[1]!)
        if (payload === null) {
          return { data: null, error: { message: "Failed to decode access token" } }
        }
        const { currentLevel, methods } = assuranceClaims(payload)
        try {
          // Determine next level: if user has verified factors, next could be aal2
          const userResult = await this.getUser()
          const factors = userResult.data.user?.factors ?? []
          const hasVerifiedFactors = factors.some((f) => f.status === "verified")
          const nextLevel = hasVerifiedFactors ? "aal2" : "aal1"
          return { data: { currentLevel, nextLevel, currentAuthenticationMethods: methods }, error: null }
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

  private getBrowserStorage(): AuthStorage | null {
    if (typeof window === "undefined") return null
    try {
      return window.localStorage
    } catch {
      return null
    }
  }

  /**
   * Keep a value for the OAuth redirect to find on the way back (a new page load, so not memory).
   * A write that fails is ignored: same-process flows still have the in-memory copy.
   */
  private async writeFlowItem(suffix: string, value: string): Promise<void> {
    if (!this.persistSession || this.storage === null) return
    try {
      await this.storage.setItem(`${this.storageKey}${suffix}`, value)
    } catch {
      // Ignore storage write failures.
    }
  }

  private async readFlowItem(suffix: string): Promise<string | null> {
    if (this.storage === null) return null
    try {
      const stored = await this.storage.getItem(`${this.storageKey}${suffix}`)
      return stored !== null && stored !== "" ? stored : null
    } catch {
      return null
    }
  }

  private async removeFlowItem(suffix: string): Promise<void> {
    if (this.storage === null) return
    try {
      await this.storage.removeItem(`${this.storageKey}${suffix}`)
    } catch {
      // Ignore
    }
  }

  /** Read a flow value once: the redirect it was kept for has now arrived. */
  private async takeFlowItem(suffix: string): Promise<string | null> {
    const value = await this.readFlowItem(suffix)
    if (value !== null) await this.removeFlowItem(suffix)
    return value
  }

  private async beginPkce(): Promise<void> {
    const verifier = generateCodeVerifier()
    this.codeVerifier = verifier
    await this.writeFlowItem(VERIFIER_SUFFIX, verifier)
  }

  private async readCodeVerifier(): Promise<string | null> {
    if (this.codeVerifier !== null) return this.codeVerifier
    this.codeVerifier = await this.readFlowItem(VERIFIER_SUFFIX)
    return this.codeVerifier
  }

  private async clearCodeVerifier(): Promise<void> {
    this.codeVerifier = null
    await this.removeFlowItem(VERIFIER_SUFFIX)
  }

  /** Decode JWT `exp` claim without verifying the signature. */
  private decodeJwtExp(accessToken: string): number | null {
    const parts = accessToken.split(".")
    if (parts.length < 2) return null
    const exp = decodeJwtPayload(parts[1]!)?.["exp"]
    return typeof exp === "number" ? exp : null
  }

  private async readStorageItem(key: string): Promise<string | null> {
    if (this.storage === null) return null
    return await this.storage.getItem(key)
  }

  private async loadPersistedSessionAsync(): Promise<Session | null> {
    const fromStorage = await this.readStorageItem(this.storageKey)
    if (fromStorage !== null) {
      const parsed = this.parsePersistedSession(fromStorage)
      if (parsed !== null) return parsed
    }
    return null
  }

  private loadPersistedSession(): Session | null {
    const raw = this.storage?.getItem(this.storageKey)
    const fromStorage =
      raw === null || raw === undefined
        ? null
        : typeof raw === "string"
          ? raw
          : null
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
    if (this.useCookies && typeof document !== "undefined") {
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
      return this.normalizePersistedSession(JSON.parse(raw))
    } catch {
      return null
    }
  }

  /** A stored session, written by this client (camelCase) or by a server-side helper (snake_case). */
  private normalizePersistedSession(raw: unknown): Session | null {
    if (!isJsonObject(raw)) return null
    const accessToken = eitherKey(raw, "accessToken", "access_token", isString)
    const user = raw["user"]
    if (accessToken === undefined || !isJsonObject(user)) return null
    const expiresAt = eitherKey(raw, "expiresAt", "expires_at", isNumber)
    return {
      accessToken,
      refreshToken: eitherKey(raw, "refreshToken", "refresh_token", isString) ?? "",
      tokenType: eitherKey(raw, "tokenType", "token_type", isString) ?? "bearer",
      expiresIn: eitherKey(raw, "expiresIn", "expires_in", isNumber) ?? 3600,
      user: this._parseUser(snakeCaseUser(user)),
      ...(expiresAt !== undefined && { expiresAt }),
    }
  }

  private syncPersistedSession(session: Session | null): void {
    if (!this.persistSession) return
    void this.writePersistedSession(session)
  }

  private async writePersistedSession(session: Session | null): Promise<void> {
    const storage = this.storage
    if (session === null) {
      try {
        await storage?.removeItem(this.storageKey)
      } catch {
        // Ignore storage write failures.
      }
      if (this.useCookies) {
        this.writeCookie(this.cookieName, "", -1)
      }
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
      await storage?.setItem(this.storageKey, json)
    } catch {
      // Ignore storage write failures.
    }
    if (this.useCookies) {
      this.writeCookie(this.cookieName, cookiePayload, session.expiresAt)
    }
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

  /** Every refusal from the auth server goes through here, so none of them drops the code. */
  private async _parseError(res: Response): Promise<SupatypeError> {
    return authErrorFromBody(await readJsonObject(res), res.status)
  }

  /** The user a `/user` response describes. Throws on a body that is not a JSON object. */
  private async _readUser(res: Response): Promise<User> {
    return this._parseUser(await readJson(res, isJsonObject))
  }

  private async _parseAuthResponse(res: Response): Promise<{
    data: { session: Session | null; user: User | null }
    error: SupatypeError | null
  }> {
    if (!res.ok) {
      return { data: { session: null, user: null }, error: await this._parseError(res) }
    }
    const json = await readJson(res, isJsonObject)
    const accessToken = json["access_token"]
    // A sign-up still waiting for its email confirmation is answered with the bare user and no
    // tokens. That is not a session, so nothing is stored and no SIGNED_IN is emitted.
    if (typeof accessToken !== "string" || accessToken === "") {
      const bareUser = json["user"]
      return { data: { session: null, user: this._parseUser(isJsonObject(bareUser) ? bareUser : json) }, error: null }
    }
    const user = this._parseUser(objectOrEmpty(json["user"]))
    const session: Session = {
      accessToken,
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
      appMetadata: objectOrEmpty(raw["app_metadata"]),
      userMetadata: objectOrEmpty(raw["user_metadata"]),
      createdAt: String(raw["created_at"] ?? ""),
      updatedAt: String(raw["updated_at"] ?? ""),
    }
    const identities = raw["identities"]
    if (Array.isArray(identities)) user.identities = identities.filter(isJsonObject).map(parseIdentity)
    const factors = raw["factors"]
    if (Array.isArray(factors)) user.factors = factors.filter(isJsonObject).map(parseFactor)
    return user
  }
}

function parseIdentity(i: Record<string, unknown>): UserIdentity {
  return {
    id: String(i["id"] ?? ""),
    userId: String(i["user_id"] ?? ""),
    identityData: objectOrEmpty(i["identity_data"]),
    identityId: String(i["identity_id"] ?? ""),
    provider: String(i["provider"] ?? ""),
    createdAt: String(i["created_at"] ?? ""),
    updatedAt: String(i["updated_at"] ?? ""),
    ...(i["last_sign_in_at"] !== undefined && { lastSignInAt: String(i["last_sign_in_at"]) }),
  }
}

/** A factor as the server lists it. A type or state it leaves out reads as `totp` / `unverified`. */
function parseFactor(f: Record<string, unknown>): Factor {
  const factorType = f["factor_type"]
  const status = f["status"]
  return {
    id: String(f["id"] ?? ""),
    factorType: isFactorType(factorType) ? factorType : "totp",
    status: isFactorStatus(status) ? status : "unverified",
    createdAt: String(f["created_at"] ?? ""),
    updatedAt: String(f["updated_at"] ?? ""),
    ...(f["friendly_name"] !== undefined && { friendlyName: String(f["friendly_name"]) }),
    ...(f["phone"] !== undefined && { phone: String(f["phone"]) }),
  }
}
