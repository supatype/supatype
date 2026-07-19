/**
 * Live smoke for @supatype/react-native against a GoTrue-compatible gateway.
 *
 * Usage:
 *   SUPATYPE_URL=http://localhost:54321 SUPATYPE_ANON_KEY=... \
 *     pnpm exec tsx examples/expo-auth/scripts/smoke-native-auth.mts
 */
import {
  createNativeClient,
  openOAuth,
  createAuthUrlListener,
  type SecureStoreLike,
} from "@supatype/react-native"

const GATEWAY = process.env["SUPATYPE_URL"] ?? "http://localhost:54321"
const ANON =
  process.env["SUPATYPE_ANON_KEY"] ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

function memorySecureStore(): SecureStoreLike & { dump(): Map<string, string> } {
  const store = new Map<string, string>()
  return {
    getItemAsync: async (key) => store.get(key) ?? null,
    setItemAsync: async (key, value) => {
      store.set(key, value)
    },
    deleteItemAsync: async (key) => {
      store.delete(key)
    },
    dump: () => store,
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

async function main(): Promise<void> {
  console.log(`Smoke target: ${GATEWAY}`)

  const health = await fetch(`${GATEWAY}/auth/v1/health`)
  assert(health.ok, `auth health failed: ${health.status}`)
  console.log("✓ auth health")

  const secureStore = memorySecureStore()
  const email = `rn-smoke-${Date.now()}@example.com`
  const password = "SmokeTest123!@#"

  const client = createNativeClient({
    url: GATEWAY,
    anonKey: ANON,
    secureStore,
  })
  await client.auth.whenReady()

  const { data: signUpData, error: signUpError } = await client.auth.signUp({
    email,
    password,
  })
  assert(signUpError === null, `signUp error: ${signUpError?.message}`)
  assert(signUpData.session !== null || signUpData.user !== null, "signUp returned empty")
  console.log("✓ signUp", signUpData.session ? "(session)" : "(user, confirm required)")

  if (signUpData.session === null) {
    const { error: signInError, data: signInData } = await client.auth.signInWithPassword({
      email,
      password,
    })
    assert(signInError === null, `signIn error: ${signInError?.message}`)
    assert(signInData.session !== null, "signIn returned no session")
    console.log("✓ signInWithPassword")
  } else {
    console.log("✓ session from signUp (autoconfirm)")
  }

  assert(secureStore.dump().size > 0, "expected session persisted to secure store")
  console.log("✓ session written to secure store")

  // Simulate app relaunch: new client, same store
  const client2 = createNativeClient({
    url: GATEWAY,
    anonKey: ANON,
    secureStore,
  })
  await client2.auth.whenReady()
  const { data: hydrated } = await client2.auth.getSession()
  assert(hydrated.session !== null, "hydrated session missing after relaunch")
  assert(hydrated.session.user.email === email || hydrated.session.user.id.length > 0, "bad user")
  console.log("✓ hydrate session after relaunch")

  // PKCE authorize URL
  const { data: oauth, error: oauthErr } = await client2.auth.signInWithOAuth({
    provider: "google",
    options: {
      flowType: "pkce",
      redirectTo: "supatype-expo-auth://auth/callback",
    },
  })
  assert(oauthErr === null, `oauth error: ${oauthErr?.message}`)
  const authUrl = new URL(oauth.url)
  assert(authUrl.searchParams.get("code_challenge_method") === "s256", "missing s256")
  assert((authUrl.searchParams.get("code_challenge") ?? "").length >= 43, "bad challenge")
  console.log("✓ signInWithOAuth PKCE challenge")

  // openOAuth cancel path
  const cancelled = await openOAuth(client2, {
    provider: "google",
    redirectTo: "supatype-expo-auth://auth/callback",
    webBrowser: {
      openAuthSessionAsync: async () => ({ type: "dismiss" }),
    },
  })
  assert(cancelled.cancelled === true, "expected cancelled")
  console.log("✓ openOAuth cancelled path")

  // Deep-link listener wires without throwing
  const unsub = createAuthUrlListener(client2, {
    linking: {
      addEventListener: () => ({ remove: () => undefined }),
      getInitialURL: async () => null,
    },
    pathIncludes: "auth/callback",
  })
  unsub()
  console.log("✓ createAuthUrlListener subscribe/unsubscribe")

  await client2.auth.signOut()
  const { data: afterOut } = await client2.auth.getSession()
  assert(afterOut.session === null, "session should be cleared")
  console.log("✓ signOut")

  console.log("\nAll live smoke checks passed.")
}

main().catch((err) => {
  console.error("\nSMOKE FAILED:", err)
  process.exit(1)
})
