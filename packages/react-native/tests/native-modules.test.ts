import { describe, it, expect, vi, beforeEach } from "vitest"
import { AuthClient, createCodeChallengeS256 } from "@supatype/client"
import { createAuthUrlListener, createNativeClient, openOAuth, secureStoreAdapter, type LinkingLike } from "../src/index.js"

/**
 * The parts of native auth that only exist on a phone: Secure Store and OS deep links.
 *
 * The expo-auth suite drives the app's web build, where storage is localStorage and a redirect is a
 * page load, so neither native module runs there. These stand in for the two modules with the same
 * surfaces (`expo-secure-store`, `expo-linking`) and assert what the app relies on them for.
 */

const AUTH_URL = "http://localhost:9999/auth/v1"
const ANON = "test-anon"
const HEADERS = { apikey: ANON, "Content-Type": "application/json" }

const TOKENS = {
  access_token: "at-native",
  refresh_token: "rt-native",
  token_type: "bearer",
  expires_in: 3600,
  user: {
    id: "u1",
    email: "a@b.com",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    app_metadata: {},
    user_metadata: {},
  },
}

/** expo-secure-store's surface, over a map that outlives any one client: the device keychain. */
function keychain() {
  const store = new Map<string, string>()
  return {
    store,
    getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    deleteItemAsync: vi.fn(async (key: string) => void store.delete(key)),
  }
}

/** expo-linking's surface, with a way to deliver a URL while the app is running. */
function linking(initial: string | null) {
  let handler: ((event: { url: string }) => void) | null = null
  const remove = vi.fn()
  const module: LinkingLike = {
    addEventListener: (_type, h) => {
      handler = h
      return { remove }
    },
    getInitialURL: async () => initial,
  }
  return { module, remove, open: (url: string) => handler?.({ url }) }
}

function tokenFetch(): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => TOKENS })
  vi.stubGlobal("fetch", fetchSpy)
  return fetchSpy
}

function isTextRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && Object.values(value).every((v) => typeof v === "string")
}

/** The body of the PKCE token exchange, or undefined when none was made. */
function exchangeBody(fetchSpy: ReturnType<typeof vi.fn>): Record<string, string> | undefined {
  const call = fetchSpy.mock.calls.find((c) => String(c[0]).includes("grant_type=pkce"))
  if (call === undefined) return undefined
  const init: unknown = call[1]
  const sent = typeof init === "object" && init !== null && "body" in init ? init.body : undefined
  const body = JSON.parse(String(sent))
  if (!isTextRecord(body)) throw new Error(`The token exchange sent ${String(sent)}`)
  return body
}

beforeEach(() => vi.restoreAllMocks())

describe("Secure Store", () => {
  it("keeps the PKCE verifier across a relaunch, so a sign-in finished after the OS killed the app still exchanges", async () => {
    const kc = keychain()
    const before = new AuthClient(AUTH_URL, HEADERS, { storage: secureStoreAdapter(kc) })
    await before.whenReady()
    const { data } = await before.signInWithOAuth({ provider: "github", options: { flowType: "pkce" } })
    const challenge = new URL(data.url).searchParams.get("code_challenge")

    // A new client over the same keychain: the app was relaunched by the deep link.
    const after = new AuthClient(AUTH_URL, HEADERS, { storage: secureStoreAdapter(kc) })
    await after.whenReady()
    const fetchSpy = tokenFetch()
    const { error } = await after.getSessionFromUrl("myapp://auth/callback?code=c1")

    expect(error).toBeNull()
    const verifier = exchangeBody(fetchSpy)?.["code_verifier"] ?? ""
    expect(createCodeChallengeS256(verifier)).toBe(challenge)
  })

  it("writes the session to the keychain on sign-in and deletes it on sign-out", async () => {
    const kc = keychain()
    const client = createNativeClient({ url: "http://localhost:9999", anonKey: ANON, secureStore: kc })
    await client.auth.whenReady()
    tokenFetch()
    await client.auth.signInWithPassword({ email: "a@b.com", password: "x" })
    expect([...kc.store.values()].some((v) => v.includes("at-native"))).toBe(true)

    await client.auth.signOut()
    expect([...kc.store.values()].some((v) => v.includes("at-native"))).toBe(false)
    expect(kc.deleteItemAsync).toHaveBeenCalled()
  })
})

describe("deep links", () => {
  async function pkceClient() {
    const auth = new AuthClient(AUTH_URL, HEADERS, { storage: secureStoreAdapter(keychain()) })
    await auth.whenReady()
    await auth.signInWithOAuth({ provider: "github", options: { flowType: "pkce" } })
    return auth
  }

  it("completes a sign-in from a link that arrives while the app is running", async () => {
    const auth = await pkceClient()
    const fetchSpy = tokenFetch()
    const link = linking(null)
    const onSession = vi.fn()
    createAuthUrlListener({ auth }, { linking: link.module, pathIncludes: "auth/callback", onSession })

    link.open("myapp://auth/callback?code=warm")
    await vi.waitFor(() => expect(onSession).toHaveBeenCalled())
    expect(exchangeBody(fetchSpy)?.["auth_code"]).toBe("warm")
  })

  it("ignores links outside the callback path, and links that carry no auth result", async () => {
    const auth = await pkceClient()
    const fetchSpy = tokenFetch()
    const link = linking("myapp://settings?code=cold")
    createAuthUrlListener({ auth }, { linking: link.module, pathIncludes: "auth/callback" })

    link.open("myapp://settings?code=warm")
    link.open("myapp://auth/callback?tab=chat")
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("reports a provider's error redirect instead of signing in", async () => {
    const auth = await pkceClient()
    const fetchSpy = tokenFetch()
    const onError = vi.fn()
    const onSession = vi.fn()
    createAuthUrlListener(
      { auth },
      { linking: linking("myapp://auth/callback?error=access_denied&error_description=User+said+no").module, onError, onSession },
    )

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "User said no" })))
    expect(onSession).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("stops listening once unsubscribed, including for a cold-start link still being read", async () => {
    const auth = await pkceClient()
    const fetchSpy = tokenFetch()
    const link = linking("myapp://auth/callback?code=late")
    const unsubscribe = createAuthUrlListener({ auth }, { linking: link.module })
    unsubscribe()

    await new Promise((r) => setTimeout(r, 20))
    expect(link.remove).toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("openOAuth on a phone", () => {
  it("hands the in-app browser the redirect to wait for, and exchanges the code it returns", async () => {
    const auth = new AuthClient(AUTH_URL, HEADERS, { storage: secureStoreAdapter(keychain()) })
    await auth.whenReady()
    const fetchSpy = tokenFetch()
    const webBrowser = {
      openAuthSessionAsync: vi.fn().mockResolvedValue({ type: "success", url: "myapp://auth/callback?code=c2" }),
    }

    const result = await openOAuth({ auth }, { provider: "github", redirectTo: "myapp://auth/callback", webBrowser })

    expect(webBrowser.openAuthSessionAsync).toHaveBeenCalledWith(expect.any(String), "myapp://auth/callback")
    expect(result.data.session?.accessToken).toBe("at-native")
    expect(exchangeBody(fetchSpy)?.["auth_code"]).toBe("c2")
  })
})
