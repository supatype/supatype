import { Platform } from "react-native"
import * as SecureStore from "expo-secure-store"
import type { AugmentedDatabase, AuthStorage } from "@supatype/client"
import { createNativeClient, secureStoreAdapter } from "@supatype/react-native"

/** Set at build time from `.env.development.local` by `expo start`; absent from `expo export`. */
function buildValue(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value
}

const url = buildValue(process.env["EXPO_PUBLIC_SUPATYPE_URL"])
const anonKey = buildValue(process.env["EXPO_PUBLIC_SUPATYPE_ANON_KEY"])

// On web, a build without them reads both from the page's /supatype-env.js (public/index.html) at
// its first request, and the client names what is missing if it cannot. A native app has no page,
// so it must be built with them.
if (Platform.OS !== "web" && (url === undefined || anonKey === undefined)) {
  throw new Error(
    "Set EXPO_PUBLIC_SUPATYPE_URL and EXPO_PUBLIC_SUPATYPE_ANON_KEY (run `supatype keys` / `supatype dev`, see .env.example).",
  )
}

/** Secure Store on native; localStorage on web (expo-secure-store is a no-op in the browser). */
function authStorage(): AuthStorage {
  if (Platform.OS === "web") {
    return {
      getItem: (key) => Promise.resolve(localStorage.getItem(key)),
      setItem: (key, value) => {
        localStorage.setItem(key, value)
        return Promise.resolve()
      },
      removeItem: (key) => {
        localStorage.removeItem(key)
        return Promise.resolve()
      },
    }
  }
  return secureStoreAdapter(SecureStore)
}

/** Typed via `supatype/generated/index.d.ts` (module augmentation of SupatypeModels). */
export const client = createNativeClient<AugmentedDatabase>({
  url,
  anonKey,
  auth: { storage: authStorage() },
})
