import React from "react"
import { View, StyleSheet } from "react-native"

/** Minimal stand-in so the example does not require react-native-safe-area-context. */
export function SafeAreaProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  return <View style={styles.root}>{children}</View>
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#ffffff" },
})
