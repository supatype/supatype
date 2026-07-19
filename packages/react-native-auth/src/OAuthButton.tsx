import React, { useState, type ReactNode } from "react"
import { Pressable, Text, type StyleProp, type ViewStyle } from "react-native"
import type { Session, SupatypeError } from "@supatype/client"
import { useSupatype } from "@supatype/react"
import { openOAuth, type WebBrowserLike } from "@supatype/react-native"
import { useAuthTheme } from "./theme.js"
import { fieldStyles } from "./styles.js"

export interface OAuthButtonProps {
  provider: string
  /** Deep link URI (required for mobile OAuth). */
  redirectTo: string
  /** Pass `import * as WebBrowser from "expo-web-browser"`. */
  webBrowser: WebBrowserLike
  scopes?: string | undefined
  onSuccess?: ((session: Session) => void) | undefined
  onError?: ((error: { message: string }) => void) | undefined
  onCancel?: (() => void) | undefined
  style?: StyleProp<ViewStyle> | undefined
  children?: ReactNode | undefined
  disabled?: boolean | undefined
  label?: string | undefined
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * OAuth sign-in button. Uses PKCE via `@supatype/react-native` `openOAuth`.
 */
export function OAuthButton({
  provider,
  redirectTo,
  webBrowser,
  scopes,
  onSuccess,
  onError,
  onCancel,
  style,
  children,
  disabled,
  label,
}: OAuthButtonProps): React.ReactElement {
  const client = useSupatype()
  const theme = useAuthTheme()
  const styles = fieldStyles(theme)
  const [loading, setLoading] = useState(false)
  const providerName = capitalize(provider)
  const isDisabled = disabled === true || loading

  async function handlePress(): Promise<void> {
    setLoading(true)
    try {
      const { data, error, cancelled } = await openOAuth(client, {
        provider,
        redirectTo,
        webBrowser,
        ...(scopes !== undefined && { scopes }),
      })
      if (cancelled) {
        onCancel?.()
        return
      }
      if (error !== null) {
        onError?.(error)
        return
      }
      if (data.session !== null) {
        onSuccess?.(data.session)
      }
    } catch (err) {
      onError?.({ message: err instanceof Error ? err.message : "OAuth failed" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Pressable
      testID={`st-oauth-${provider}`}
      accessibilityRole="button"
      accessibilityLabel={label ?? `Sign in with ${providerName}`}
      accessibilityState={{ disabled: isDisabled }}
      disabled={isDisabled}
      onPress={() => {
        void handlePress()
      }}
      style={[styles.secondaryButton, isDisabled ? styles.buttonDisabled : null, style]}
    >
      <Text style={styles.secondaryButtonText}>
        {children ??
          (loading ? `Connecting to ${providerName}…` : (label ?? `Sign in with ${providerName}`))}
      </Text>
    </Pressable>
  )
}

export type { SupatypeError }
