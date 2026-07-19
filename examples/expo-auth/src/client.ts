import * as SecureStore from "expo-secure-store"
import { createNativeClient } from "@supatype/react-native"

const url = process.env["EXPO_PUBLIC_SUPATYPE_URL"]
const anonKey = process.env["EXPO_PUBLIC_SUPATYPE_ANON_KEY"]

if (url === undefined || url === "" || anonKey === undefined || anonKey === "") {
  throw new Error(
    "Set EXPO_PUBLIC_SUPATYPE_URL and EXPO_PUBLIC_SUPATYPE_ANON_KEY (see .env.example).",
  )
}

export const client = createNativeClient({
  url,
  anonKey,
  secureStore: SecureStore,
})
