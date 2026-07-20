/**
 * Live smoke for @supatype/react-native against a local Supatype stack.
 *
 * Prerequisites: `supatype push` + `supatype dev` in examples/expo-auth
 * (Kong gateway, default http://localhost:18473).
 *
 * Usage (from examples/expo-auth):
 *   pnpm smoke
 *
 * Or from monorepo root:
 *   pnpm exec tsx examples/expo-auth/scripts/smoke-native-auth.mts
 */
import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { AugmentedDatabase, RealtimePayload } from "@supatype/client"
import { RealtimeClient } from "@supatype/client"
import {
  createNativeClient,
  openOAuth,
  createAuthUrlListener,
  type SecureStoreLike,
} from "@supatype/react-native"

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function loadDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

const envFile = loadDotEnv(resolve(exampleRoot, ".env"))

const GATEWAY =
  process.env["SUPATYPE_URL"] ??
  envFile["EXPO_PUBLIC_SUPATYPE_URL"] ??
  envFile["PUBLIC_SUPATYPE_URL"] ??
  "http://localhost:18473"

const ANON =
  process.env["SUPATYPE_ANON_KEY"] ??
  envFile["EXPO_PUBLIC_SUPATYPE_ANON_KEY"] ??
  envFile["ANON_KEY"] ??
  ""

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
  assert(ANON.length > 0, "Missing ANON_KEY — run `supatype keys` or `supatype dev` in examples/expo-auth")
  console.log(`Smoke target: ${GATEWAY}`)

  const health = await fetch(`${GATEWAY}/auth/v1/health`)
  assert(health.ok, `auth health failed: ${health.status} (is \`supatype dev\` running?)`)
  console.log("✓ auth health")

  const secureStore = memorySecureStore()
  const email = `rn-smoke-${Date.now()}@example.com`
  const password = "SmokeTest123!@#"

  const client = createNativeClient<AugmentedDatabase>({
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

  const { data: sessionData } = await client.auth.getSession()
  const userId = sessionData.session?.user.id
  assert(userId !== undefined, "missing user id for profile smoke")

  const { error: upsertError } = await client.from("profile").upsert({
    id: userId,
    displayName: "smoke",
  })
  assert(upsertError === null, `profile upsert error: ${upsertError?.message}`)
  const { data: profile, error: profileError } = await client
    .from("profile")
    .select("displayName")
    .eq("id", userId)
    .maybeSingle()
  assert(profileError === null, `profile select error: ${profileError?.message}`)
  assert(profile?.displayName === "smoke", "profile displayName mismatch")
  console.log("✓ profile upsert + select (schema REST)")

  // Realtime lobby chat (user JWT — LoggedIn RLS)
  const accessToken = sessionData.session?.accessToken
  assert(accessToken !== undefined && accessToken.length > 0, "missing access token for realtime")
  const rtEvents: RealtimePayload<Record<string, unknown>>[] = []
  const rt = new RealtimeClient(`${GATEWAY.replace(/\/$/, "")}/realtime/v1`, {
    apikey: accessToken,
    Authorization: `Bearer ${accessToken}`,
  })
  const LOBBY = "lobby"
  const channel = rt
    .channel("public:chat_message")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "chat_message",
        filter: `room=eq.${LOBBY}`,
      },
      (payload) => rtEvents.push(payload),
    )
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("realtime subscribe timeout")), 15_000)
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer)
        resolve()
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer)
        reject(new Error(`realtime subscribe failed: ${status}`))
      }
    })
  })
  await new Promise((r) => setTimeout(r, 400))
  const chatBody = `smoke-${Date.now()}`
  const { error: chatInsertError } = await client.from("chat_message").insert({
    room: LOBBY,
    body: chatBody,
    auth_user_id: userId,
    authorName: "smoke",
  } as AugmentedDatabase["public"]["Tables"]["chat_message"]["Insert"])
  assert(chatInsertError === null, `chat insert error: ${chatInsertError?.message}`)
  const deadline = Date.now() + 8_000
  while (rtEvents.length < 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
  }
  assert(rtEvents.length >= 1, "expected realtime INSERT for chat_message")
  assert(
    (rtEvents[0]?.new as { body?: string } | null)?.body === chatBody,
    "realtime payload body mismatch",
  )
  channel.unsubscribe()
  rt.disconnect()
  console.log("✓ realtime chat_message INSERT")

  // Simulate app relaunch: new client, same store
  const client2 = createNativeClient<AugmentedDatabase>({
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
