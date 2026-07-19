# `@supatype/react-native-auth`

Pre-built React Native auth UI for Supatype (email, magic link, OAuth, password reset).

Requires a `<SupatypeProvider>` from `@supatype/react` and a client from `@supatype/react-native`.

## Install

```bash
npx expo install @supatype/react @supatype/react-native @supatype/react-native-auth \
  expo-secure-store expo-web-browser expo-linking
```

## Usage

```tsx
import * as SecureStore from "expo-secure-store"
import * as WebBrowser from "expo-web-browser"
import * as Linking from "expo-linking"
import { SupatypeProvider } from "@supatype/react"
import { createNativeClient } from "@supatype/react-native"
import {
  AuthGate,
  AuthThemeProvider,
  LoginForm,
  MagicLinkForm,
  OAuthButton,
  ResetPassword,
  SignUpForm,
} from "@supatype/react-native-auth"

const client = createNativeClient({
  url: process.env.EXPO_PUBLIC_SUPATYPE_URL!,
  anonKey: process.env.EXPO_PUBLIC_SUPATYPE_ANON_KEY!,
  secureStore: SecureStore,
})

const redirectTo = Linking.createURL("auth/callback")

export default function App() {
  return (
    <SupatypeProvider client={client}>
      <AuthThemeProvider>
        <AuthGate
          fallback={
            <>
              <LoginForm />
              <MagicLinkForm redirectTo={redirectTo} />
              <OAuthButton
                provider="google"
                redirectTo={redirectTo}
                webBrowser={WebBrowser}
              />
              <ResetPassword redirectTo={redirectTo} />
            </>
          }
        >
          {/* signed-in app */}
        </AuthGate>
      </AuthThemeProvider>
    </SupatypeProvider>
  )
}
```

OAuth uses **PKCE** by default via `openOAuth`.
