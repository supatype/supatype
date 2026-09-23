import React, { useState } from "react"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import * as Linking from "expo-linking"
import * as WebBrowser from "expo-web-browser"
import {
  LoginForm,
  MagicLinkForm,
  OAuthButton,
  ResetPassword,
  SignUpForm,
} from "@supatype/react-native-auth"

type Tab = "login" | "signup" | "magic" | "reset"

const TABS: { id: Tab; label: string }[] = [
  { id: "login", label: "Sign in" },
  { id: "signup", label: "Sign up" },
  { id: "magic", label: "Magic link" },
  { id: "reset", label: "Reset" },
]

export function AuthScreen(): React.ReactElement {
  const [tab, setTab] = useState<Tab>("login")
  const redirectTo = Linking.createURL("auth/callback")

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.brand}>Supatype</Text>
      <Text style={styles.subtitle}>Expo auth example</Text>

      <View style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => setTab(t.id)}
            style={[styles.tab, tab === t.id ? styles.tabActive : null]}
          >
            <Text style={[styles.tabText, tab === t.id ? styles.tabTextActive : null]}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.panel}>
        {tab === "login" && <LoginForm />}
        {tab === "signup" && <SignUpForm />}
        {tab === "magic" && <MagicLinkForm redirectTo={redirectTo} />}
        {tab === "reset" && <ResetPassword redirectTo={redirectTo} />}
      </View>

      <View style={styles.oauth}>
        <Text style={styles.oauthLabel}>Or continue with</Text>
        <OAuthButton
          provider="google"
          redirectTo={redirectTo}
          webBrowser={WebBrowser}
        />
        <OAuthButton
          provider="github"
          redirectTo={redirectTo}
          webBrowser={WebBrowser}
        />
        <Text style={styles.hint}>
          Redirect URI (allowlist this in auth settings):{"\n"}
          {redirectTo}
        </Text>
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    padding: 24,
    paddingTop: 64,
    gap: 16,
    backgroundColor: "#ffffff",
  },
  brand: {
    fontSize: 28,
    fontWeight: "700",
    color: "#0f766e",
  },
  subtitle: {
    fontSize: 14,
    color: "#6b7280",
    marginBottom: 8,
  },
  tabs: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tab: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "#f3f4f6",
  },
  tabActive: {
    backgroundColor: "#0f766e",
  },
  tabText: {
    fontSize: 13,
    color: "#374151",
    fontWeight: "500",
  },
  tabTextActive: {
    color: "#ffffff",
  },
  panel: {
    minHeight: 280,
  },
  oauth: {
    gap: 10,
    marginTop: 8,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
  },
  oauthLabel: {
    fontSize: 13,
    color: "#6b7280",
    marginBottom: 4,
  },
  hint: {
    marginTop: 8,
    fontSize: 11,
    color: "#9ca3af",
    lineHeight: 16,
  },
})
