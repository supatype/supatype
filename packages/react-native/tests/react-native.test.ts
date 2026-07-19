import { describe, it, expect, vi, beforeEach } from "vitest"
import { AuthClient } from "@supatype/client"
import {
  asyncStorageAdapter,
  createAuthUrlListener,
  createNativeClient,
  openOAuth,
  secureStoreAdapter,
} from "../src/index.js"

const GOTRUE = "http://localhost:9999"
const ANON = "test-anon"

function memorySecureStore() {
  const store = new Map<string, string>()
  return {
    store,
    getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      store.delete(key)
    }),
  }
}

describe("storage adapters", () => {
  it("secureStoreAdapter round-trips", async () => {
    const ss = memorySecureStore()
    const storage = secureStoreAdapter(ss)
    await storage.setItem("k", "v")
    expect(await storage.getItem("k")).toBe("v")
    await storage.removeItem("k")
    expect(await storage.getItem("k")).toBeNull()
  })

  it("asyncStorageAdapter round-trips", async () => {
    const store = new Map<string, string>()
    const storage = asyncStorageAdapter({
      getItem: async (k) => store.get(k) ?? null,
      setItem: async (k, v) => {
        store.set(k, v)
      },
      removeItem: async (k) => {
        store.delete(k)
      },
    })
    await storage.setItem("a", "b")
    expect(await storage.getItem("a")).toBe("b")
  })
})

describe("createNativeClient", () => {
  it("injects secureStore as auth.storage", async () => {
    const ss = memorySecureStore()
    const client = createNativeClient({
      url: GOTRUE,
      anonKey: ANON,
      secureStore: ss,
    })
    await client.auth.whenReady()

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "at",
          refresh_token: "rt",
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
        }),
      }),
    )

    await client.auth.signInWithPassword({ email: "a@b.com", password: "x" })
    expect(ss.setItemAsync).toHaveBeenCalled()
    const values = ss.setItemAsync.mock.calls.map((c) => c[1] as string)
    expect(values.some((v) => v.includes("accessToken") || v.includes("at"))).toBe(true)
  })

  it("throws when no storage module is provided", () => {
    expect(() =>
      createNativeClient({ url: GOTRUE, anonKey: ANON }),
    ).toThrow(/secureStore/)
  })
})

describe("openOAuth", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("uses PKCE by default and exchanges success URL", async () => {
    const ss = memorySecureStore()
    const auth = new AuthClient(`${GOTRUE}/auth/v1`, {
      apikey: ANON,
      "Content-Type": "application/json",
    }, { storage: secureStoreAdapter(ss) })
    await auth.whenReady()

    const client = { auth }

    const webBrowser = {
      openAuthSessionAsync: vi.fn().mockResolvedValue({
        type: "success",
        url: "myapp://auth/callback?code=auth-code-1",
      }),
    }

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "at-oauth",
          refresh_token: "rt-oauth",
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
        }),
      }),
    )

    const result = await openOAuth(client, {
      provider: "google",
      redirectTo: "myapp://auth/callback",
      webBrowser,
    })

    expect(result.cancelled).toBe(false)
    expect(result.error).toBeNull()
    expect(result.data.session?.accessToken).toBe("at-oauth")
    expect(webBrowser.openAuthSessionAsync).toHaveBeenCalled()
    const [authorizeUrl] = webBrowser.openAuthSessionAsync.mock.calls[0] as [string]
    expect(authorizeUrl).toContain("code_challenge=")
    expect(authorizeUrl).toContain("code_challenge_method=s256")
  })

  it("returns cancelled when browser is dismissed", async () => {
    const auth = new AuthClient(`${GOTRUE}/auth/v1`, {
      apikey: ANON,
      "Content-Type": "application/json",
    })
    const result = await openOAuth(
      { auth },
      {
        provider: "google",
        redirectTo: "myapp://cb",
        webBrowser: {
          openAuthSessionAsync: async () => ({ type: "dismiss" }),
        },
      },
    )
    expect(result.cancelled).toBe(true)
    expect(result.data.session).toBeNull()
  })
})

describe("createAuthUrlListener", () => {
  it("handles initial URL with code", async () => {
    const ss = memorySecureStore()
    const auth = new AuthClient(`${GOTRUE}/auth/v1`, {
      apikey: ANON,
      "Content-Type": "application/json",
    }, { storage: secureStoreAdapter(ss) })
    await auth.whenReady()
    await auth.signInWithOAuth({
      provider: "google",
      options: { flowType: "pkce" },
    })

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "at",
          refresh_token: "rt",
          token_type: "bearer",
          expires_in: 3600,
          user: {
            id: "u1",
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
            app_metadata: {},
            user_metadata: {},
          },
        }),
      }),
    )

    const onSession = vi.fn()
    let urlHandler: ((e: { url: string }) => void) | null = null

    const unsubscribe = createAuthUrlListener(
      { auth },
      {
        linking: {
          addEventListener: (_type, handler) => {
            urlHandler = handler
            return { remove: vi.fn() }
          },
          getInitialURL: async () => "myapp://auth/callback?code=from-cold-start",
        },
        pathIncludes: "auth/callback",
        onSession,
      },
    )

    await vi.waitFor(() => {
      expect(onSession).toHaveBeenCalled()
    })

    expect(urlHandler).not.toBeNull()
    unsubscribe()
  })
})
