# `@supatype/react-native`

React Native / Expo helpers for Supatype: secure session persistence, PKCE OAuth, and deep-link auth completion.

## Install

```bash
npx expo install @supatype/client @supatype/react @supatype/react-native \
  expo-secure-store expo-web-browser expo-linking
```

## Quick start

```ts
import * as SecureStore from "expo-secure-store"
import * as WebBrowser from "expo-web-browser"
import * as Linking from "expo-linking"
import { SupatypeProvider } from "@supatype/react"
import {
  createNativeClient,
  openOAuth,
  createAuthUrlListener,
} from "@supatype/react-native"

const client = createNativeClient({
  url: process.env.EXPO_PUBLIC_SUPATYPE_URL!,
  anonKey: process.env.EXPO_PUBLIC_SUPATYPE_ANON_KEY!,
  secureStore: SecureStore, // PKCE verifier + session JWT in Secure Store
})

// OAuth (PKCE by default)
const redirectTo = Linking.createURL("auth/callback")
await openOAuth(client, {
  provider: "google",
  redirectTo,
  webBrowser: WebBrowser,
})

// Cold-start / background deep links
const unsubscribe = createAuthUrlListener(client, {
  linking: Linking,
  pathIncludes: "auth/callback",
})
```

Register `redirectTo` in your auth server URI allowlist and set the Expo `scheme` in `app.json`.

## Notes

- `createNativeClient` injects `auth.storage` so sessions survive app restarts (no `localStorage`).
- `openOAuth` defaults to `flowType: "pkce"`. Pass `flowType: "implicit"` only if you need hash-token redirects.
- Pass `asyncStorage` instead of `secureStore` if you are not using Expo Secure Store.
