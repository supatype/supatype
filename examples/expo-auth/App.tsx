import React, { useEffect } from "react"
import { StatusBar } from "expo-status-bar"
import * as Linking from "expo-linking"
import { SupatypeProvider } from "@supatype/react"
import { createAuthUrlListener } from "@supatype/react-native"
import { AuthGate, AuthThemeProvider } from "@supatype/react-native-auth"
import { SafeAreaProvider } from "./src/SafeAreaFallback"
import { client } from "./src/client"
import { AuthScreen } from "./src/AuthScreen"
import { MainScreen } from "./src/MainScreen"

export default function App(): React.ReactElement {
  useEffect(() => {
    return createAuthUrlListener(client, {
      linking: Linking,
      pathIncludes: "auth/callback",
    })
  }, [])

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SupatypeProvider client={client}>
        <AuthThemeProvider>
          <AuthGate fallback={<AuthScreen />}>
            <MainScreen />
          </AuthGate>
        </AuthThemeProvider>
      </SupatypeProvider>
    </SafeAreaProvider>
  )
}
