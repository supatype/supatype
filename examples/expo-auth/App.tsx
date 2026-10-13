import React, { useEffect } from "react"
import { StyleSheet, Text } from "react-native"
import { StatusBar } from "expo-status-bar"
import * as Linking from "expo-linking"
import { SupatypeProvider } from "@supatype/react"
import { createAuthUrlListener } from "@supatype/react-native"
import { AuthGate, AuthThemeProvider, ResetPassword } from "@supatype/react-native-auth"
import { SafeAreaProvider } from "./src/SafeAreaFallback"
import { client } from "./src/client"
import { AuthScreen } from "./src/AuthScreen"
import { MainScreen } from "./src/MainScreen"
import { completesOAuthPopup, useRecoveryLink } from "./src/authRedirect"

// Decided once, before anything renders: in a web OAuth popup this hands the URL to the opener,
// which closes the popup when it has it.
const isOAuthPopup = completesOAuthPopup()

export default function App(): React.ReactElement {
  if (isOAuthPopup) {
    return <Text style={styles.completing}>Completing sign-in…</Text>
  }
  return <AuthApp />
}

function AuthApp(): React.ReactElement {
  const { recovering, done } = useRecoveryLink()

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
            {recovering ? <ResetPassword mode="update" onPasswordUpdated={done} /> : <MainScreen />}
          </AuthGate>
        </AuthThemeProvider>
      </SupatypeProvider>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  completing: { padding: 24, color: "#6b7280" },
})
