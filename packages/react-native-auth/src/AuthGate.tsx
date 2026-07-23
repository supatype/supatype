import React from "react"
import { ActivityIndicator, View, type StyleProp, type ViewStyle } from "react-native"
import { useAuth } from "@supatype/react"
import { useAuthTheme } from "./theme.js"

export interface AuthGateProps {
  children: React.ReactNode
  /** Rendered when signed out. Default: null. */
  fallback?: React.ReactNode | undefined
  /** Rendered while the initial session is loading. Default: ActivityIndicator. */
  loadingFallback?: React.ReactNode | undefined
  style?: StyleProp<ViewStyle> | undefined
}

/**
 * Renders `children` only when a session exists. Must be inside `<SupatypeProvider>`.
 */
export function AuthGate({
  children,
  fallback = null,
  loadingFallback,
  style,
}: AuthGateProps): React.ReactElement {
  const { session, loading } = useAuth()
  const theme = useAuthTheme()

  if (loading) {
    return (
      <View
        style={[{ flex: 1, alignItems: "center", justifyContent: "center" }, style]}
        testID="st-auth-gate-loading"
      >
        {loadingFallback ?? <ActivityIndicator color={theme.colorPrimary} testID="st-auth-gate-spinner" />}
      </View>
    )
  }

  if (session === null) {
    return <>{fallback}</>
  }

  return <>{children}</>
}
