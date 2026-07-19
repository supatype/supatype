import React from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { useAuth } from "@supatype/react"

export function HomeScreen(): React.ReactElement {
  const { user, signOut } = useAuth()

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Signed in</Text>
      <Text style={styles.email}>{user?.email ?? user?.id ?? "Authenticated"}</Text>
      <Pressable
        style={styles.button}
        onPress={() => {
          void signOut()
        }}
        accessibilityRole="button"
        accessibilityLabel="Sign out"
      >
        <Text style={styles.buttonText}>Sign out</Text>
      </Pressable>
      <Text style={styles.hint}>
        Kill and relaunch the app — the session should still be present (Secure Store).
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    paddingTop: 80,
    gap: 12,
    backgroundColor: "#ffffff",
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#111827",
  },
  email: {
    fontSize: 16,
    color: "#0f766e",
  },
  button: {
    marginTop: 16,
    backgroundColor: "#111827",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonText: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 14,
  },
  hint: {
    marginTop: 24,
    fontSize: 13,
    color: "#6b7280",
    lineHeight: 18,
  },
})
