import { describe, it, expect, vi, afterEach } from "vitest"
import { AuthClient, ssoDomain } from "../src/auth.js"
import { SupatypeError } from "../src/errors.js"
import { createCodeChallengeS256, PKCE_METHOD_S256 } from "../src/pkce.js"
import { fetchCall, fetchReturning, jsonBody } from "./support/fetch-mock.js"
import { stubBrowser } from "./support/browser.js"
import { liveAccessToken } from "./support/jwt.js"

/**
 * `signInWithSSO`: SAML single sign-on, started by the user's email domain or a provider's ID.
 *
 * The client asks `POST /sso` for the identity provider's URL (`skip_http_redirect`, since a fetch
 * cannot follow the server's 303 to another origin) and sends the browser there, unless asked not to.
 */

const AUTH_URL = "http://localhost:9999/auth/v1"
const HEADERS = { apikey: "anon", "Content-Type": "application/json" }
const IDP_URL = "https://idp.example/sso?SAMLRequest=abc&RelayState=r1"
const VERIFIER_KEY = "supatype.auth.session-code-verifier"
const PROVIDER_KEY = "supatype.auth.session-oauth-provider"
const PROVIDER_ID = "8a6f1f4e-2b1c-4f5e-9d3a-6b7c8d9e0f1a"

const PAGE = "https://app.example/login"

/** The challenge fields a PKCE sign-in adds to the /sso body. */
const ANY_STRING: unknown = expect.any(String)
const PKCE_FIELDS = { code_challenge: ANY_STRING, code_challenge_method: PKCE_METHOD_S256 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("signInWithSSO request", () => {
  it("posts the email domain to /sso and asks for the URL rather than a redirect", async () => {
    stubBrowser(PAGE)
    const fetch = fetchReturning({ url: IDP_URL })
    vi.stubGlobal("fetch", fetch)

    await new AuthClient(AUTH_URL, HEADERS).signInWithSSO({ domain: "acme.com" })

    const { url, init } = fetchCall(fetch)
    expect(url).toBe(`${AUTH_URL}/sso`)
    expect(init.method).toBe("POST")
    expect(jsonBody(init)).toEqual({ domain: "acme.com", skip_http_redirect: true, ...PKCE_FIELDS })
  })

  it("posts a provider ID as provider_id, with no domain", async () => {
    stubBrowser(PAGE)
    const fetch = fetchReturning({ url: IDP_URL })
    vi.stubGlobal("fetch", fetch)

    await new AuthClient(AUTH_URL, HEADERS).signInWithSSO({ providerId: PROVIDER_ID })

    expect(jsonBody(fetchCall(fetch).init)).toEqual({ provider_id: PROVIDER_ID, skip_http_redirect: true, ...PKCE_FIELDS })
  })

  it("sends redirectTo as redirect_to and the captcha token where the server checks it", async () => {
    stubBrowser(PAGE)
    const fetch = fetchReturning({ url: IDP_URL })
    vi.stubGlobal("fetch", fetch)

    await new AuthClient(AUTH_URL, HEADERS).signInWithSSO({
      domain: "acme.com",
      options: { redirectTo: "https://app.example/welcome", captchaToken: "cap-1" },
    })

    expect(jsonBody(fetchCall(fetch).init)).toEqual({
      domain: "acme.com",
      skip_http_redirect: true,
      redirect_to: "https://app.example/welcome",
      supatype_meta_security: { captcha_token: "cap-1" },
      ...PKCE_FIELDS,
    })
  })

  it("sends studio: true only when asked, so the server returns the browser to Studio", async () => {
    stubBrowser(PAGE)
    const fetch = fetchReturning({ url: IDP_URL })
    vi.stubGlobal("fetch", fetch)
    const client = new AuthClient(AUTH_URL, HEADERS)

    await client.signInWithSSO({ domain: "acme.com", options: { studio: true } })
    await client.signInWithSSO({ domain: "acme.com", options: { studio: false } })

    expect(jsonBody(fetchCall(fetch, 0).init)).toEqual({ domain: "acme.com", skip_http_redirect: true, studio: true, ...PKCE_FIELDS })
    expect(jsonBody(fetchCall(fetch, 1).init)).toEqual({ domain: "acme.com", skip_http_redirect: true, ...PKCE_FIELDS })
  })
})

describe("signInWithSSO PKCE", () => {
  it("sends the S256 challenge of a stored verifier by default", async () => {
    const { store } = stubBrowser(PAGE)
    const fetch = fetchReturning({ url: IDP_URL })
    vi.stubGlobal("fetch", fetch)

    await new AuthClient(AUTH_URL, HEADERS).signInWithSSO({ domain: "acme.com" })

    const verifier = store.get(VERIFIER_KEY)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const body = jsonBody(fetchCall(fetch).init)
    expect(body["code_challenge"]).toBe(createCodeChallengeS256(verifier!))
    expect(body["code_challenge_method"]).toBe(PKCE_METHOD_S256)
  })

  it("sends no challenge for flowType implicit", async () => {
    const { store } = stubBrowser(PAGE)
    const fetch = fetchReturning({ url: IDP_URL })
    vi.stubGlobal("fetch", fetch)

    await new AuthClient(AUTH_URL, HEADERS).signInWithSSO({ domain: "acme.com", options: { flowType: "implicit" } })

    const body = jsonBody(fetchCall(fetch).init)
    expect(body["code_challenge"]).toBeUndefined()
    expect(body["code_challenge_method"]).toBeUndefined()
    expect(store.has(VERIFIER_KEY)).toBe(false)
  })

  it("leaves signInWithOAuth's default implicit", async () => {
    const { store } = stubBrowser(PAGE)
    vi.stubGlobal("fetch", fetchReturning({ external: { github: true } }))

    const { data } = await new AuthClient(AUTH_URL, HEADERS).signInWithOAuth({ provider: "github" })

    expect(new URL(data.url).searchParams.has("code_challenge")).toBe(false)
    expect(store.has(VERIFIER_KEY)).toBe(false)
  })

  it("remembers the sign-in as SSO, so a refusal sent back in the URL names it", async () => {
    const { store } = stubBrowser(PAGE)
    vi.stubGlobal("fetch", fetchReturning({ url: IDP_URL }))

    await new AuthClient(AUTH_URL, HEADERS).signInWithSSO({ domain: "acme.com" })

    expect(store.get(PROVIDER_KEY)).toBe("sso")
  })
})

describe("signInWithSSO redirect", () => {
  it("returns the identity provider's URL and sends the browser there", async () => {
    const { assign } = stubBrowser(PAGE)
    vi.stubGlobal("fetch", fetchReturning({ url: IDP_URL }))

    const { data, error } = await new AuthClient(AUTH_URL, HEADERS).signInWithSSO({ domain: "acme.com" })

    expect(error).toBeNull()
    expect(data.url).toBe(IDP_URL)
    expect(assign).toHaveBeenCalledWith(IDP_URL)
  })

  it("returns the URL and stays put with skipBrowserRedirect", async () => {
    const { assign } = stubBrowser(PAGE)
    vi.stubGlobal("fetch", fetchReturning({ url: IDP_URL }))

    const { data } = await new AuthClient(AUTH_URL, HEADERS).signInWithSSO({
      domain: "acme.com",
      options: { skipBrowserRedirect: true },
    })

    expect(data.url).toBe(IDP_URL)
    expect(assign).not.toHaveBeenCalled()
  })

  it("returns the URL outside a browser without touching window", async () => {
    vi.stubGlobal("fetch", fetchReturning({ url: IDP_URL }))

    const { data, error } = await new AuthClient(AUTH_URL, HEADERS).signInWithSSO({ domain: "acme.com" })

    expect(error).toBeNull()
    expect(data.url).toBe(IDP_URL)
  })
})

describe("signInWithSSO errors", () => {
  it("returns the server's refusal as a SupatypeError with its code, and does not navigate", async () => {
    const { assign } = stubBrowser(PAGE)
    vi.stubGlobal("fetch", fetchReturning(
      { code: 404, error_code: "sso_provider_not_found", msg: "No SSO provider assigned for this domain" },
      404,
    ))

    const { data, error } = await new AuthClient(AUTH_URL, HEADERS).signInWithSSO({ domain: "nope.com" })

    expect(error).toBeInstanceOf(SupatypeError)
    expect(error?.code).toBe("sso_provider_not_found")
    expect(error?.status).toBe(404)
    expect(error?.message).toBe("No SSO provider assigned for this domain")
    expect(data.url).toBe("")
    expect(assign).not.toHaveBeenCalled()
  })

  it("refuses an answer with no URL rather than navigating nowhere", async () => {
    const { assign } = stubBrowser(PAGE)
    vi.stubGlobal("fetch", fetchReturning({}))

    const { data, error } = await new AuthClient(AUTH_URL, HEADERS).signInWithSSO({ domain: "acme.com" })

    expect(error).toBeInstanceOf(SupatypeError)
    expect(data.url).toBe("")
    expect(assign).not.toHaveBeenCalled()
  })

  it("rejects both a domain and a provider ID at compile time", () => {
    const client = new AuthClient(AUTH_URL, HEADERS)
    const both = (): unknown =>
      // @ts-expect-error: one of domain or providerId, never both
      client.signInWithSSO({ domain: "acme.com", providerId: PROVIDER_ID })
    expect(typeof both).toBe("function")
  })
})

const RAW_USER = {
  id: "user-sso",
  email: "sso-tester@acme.supatype.test",
  created_at: "2026-11-06T00:00:00Z",
  updated_at: "2026-11-06T00:00:00Z",
  app_metadata: { provider: "sso:0b4a7c1e" },
  user_metadata: {},
}

describe("an SSO sign-in coming back to the app", () => {
  it("exchanges the code of a sign-in this browser started for a session", async () => {
    const started = stubBrowser(PAGE)
    vi.stubGlobal("fetch", fetchReturning({ url: IDP_URL }))
    await new AuthClient(AUTH_URL, HEADERS).signInWithSSO({ domain: "acme.supatype.test" })
    const verifier = started.store.get(VERIFIER_KEY)

    const { replaceState } = stubBrowser("https://app.example/home?code=sso-code-1", Object.fromEntries(started.store))
    const fetch = fetchReturning({ access_token: liveAccessToken(), refresh_token: "rt-sso", expires_in: 3600, token_type: "bearer", user: RAW_USER })
    vi.stubGlobal("fetch", fetch)
    const client = new AuthClient(AUTH_URL, HEADERS)
    const { error } = await client.initialize()

    expect(error).toBeNull()
    const { url, init } = fetchCall(fetch)
    expect(url).toBe(`${AUTH_URL}/token?grant_type=pkce`)
    expect(jsonBody(init)).toEqual({ auth_code: "sso-code-1", code_verifier: verifier })
    expect((await client.getSession()).data.session?.user.id).toBe("user-sso")
    expect(replaceState).toHaveBeenCalledWith(null, "", "https://app.example/home")
  })

  it("signs in from tokens in the fragment for an identity-provider-initiated login it did not start", async () => {
    const token = liveAccessToken()
    const { replaceState } = stubBrowser(`https://app.example/#access_token=${token}&refresh_token=rt-idp&expires_in=3600&token_type=bearer`)
    const fetch = fetchReturning(RAW_USER)
    vi.stubGlobal("fetch", fetch)
    const client = new AuthClient(AUTH_URL, HEADERS)
    const { error } = await client.initialize()

    expect(error).toBeNull()
    expect(fetchCall(fetch).url).toBe(`${AUTH_URL}/user`)
    const { data } = await client.getSession()
    expect(data.session?.accessToken).toBe(token)
    expect(data.session?.user.id).toBe("user-sso")
    expect(replaceState).toHaveBeenCalledWith(null, "", "https://app.example/")
  })

  it("takes fragment tokens even while a PKCE sign-in it started is still waiting", async () => {
    const token = liveAccessToken()
    stubBrowser(`https://app.example/#access_token=${token}&refresh_token=rt-idp&expires_in=3600&token_type=bearer`, {
      [VERIFIER_KEY]: "abandoned-verifier",
      [PROVIDER_KEY]: "sso",
    })
    const fetch = fetchReturning(RAW_USER)
    vi.stubGlobal("fetch", fetch)
    const client = new AuthClient(AUTH_URL, HEADERS)
    const { error } = await client.initialize()

    expect(error).toBeNull()
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([`${AUTH_URL}/user`])
    expect((await client.getSession()).data.session?.accessToken).toBe(token)
  })
})

describe("ssoDomain: the domain SSO is looked up by", () => {
  it("is the part after the last @, trimmed and lower-cased", () => {
    expect(ssoDomain("Admin@Acme.COM")).toBe("acme.com")
    expect(ssoDomain("odd@name@acme.com")).toBe("acme.com")
    expect(ssoDomain("  you@ Acme.com  ")).toBe("acme.com")
  })

  it("is the whole of a bare domain, which an SSO form may be typed with", () => {
    expect(ssoDomain("Acme.com")).toBe("acme.com")
  })

  it("is null when nothing is left to look up", () => {
    expect(ssoDomain("")).toBeNull()
    expect(ssoDomain("admin@ ")).toBeNull()
    expect(ssoDomain("   ")).toBeNull()
  })
})
