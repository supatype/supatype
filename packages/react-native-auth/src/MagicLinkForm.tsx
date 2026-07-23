import React, { useState } from "react"
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native"
import type { SupatypeError } from "@supatype/client"
import { useAuth } from "@supatype/react"
import { useAuthTheme } from "./theme.js"
import { fieldStyles } from "./styles.js"

export interface MagicLinkFormLabels {
  title?: string | undefined
  email?: string | undefined
  submit?: string | undefined
  successMessage?: string | undefined
}

export interface MagicLinkFormProps {
  /** Deep link / redirect used as `emailRedirectTo` for the magic link. */
  redirectTo?: string | undefined
  onSent?: (() => void) | undefined
  onError?: ((error: SupatypeError) => void) | undefined
  labels?: MagicLinkFormLabels | undefined
  style?: StyleProp<ViewStyle> | undefined
  contentContainerStyle?: StyleProp<ViewStyle> | undefined
}

const DEFAULT_LABELS: Required<MagicLinkFormLabels> = {
  title: "Sign in with email",
  email: "Email address",
  submit: "Send magic link",
  successMessage: "Check your email for a sign-in link.",
}

export function MagicLinkForm({
  redirectTo,
  onSent,
  onError,
  labels,
  style,
  contentContainerStyle,
}: MagicLinkFormProps): React.ReactElement {
  const { signInWithOtp } = useAuth()
  const theme = useAuthTheme()
  const styles = fieldStyles(theme)
  const l = { ...DEFAULT_LABELS, ...labels }

  const [email, setEmail] = useState("")
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function handleSubmit(): Promise<void> {
    setErrorMessage(null)
    setLoading(true)
    try {
      const { error } = await signInWithOtp({
        email,
        ...(redirectTo !== undefined && { options: { emailRedirectTo: redirectTo } }),
      })
      if (error !== null) {
        setErrorMessage(error.message)
        onError?.(error)
      } else {
        setSent(true)
        onSent?.()
      }
    } finally {
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <View style={[styles.root, style]} testID="st-magic-link-sent">
        <Text style={styles.muted} accessibilityLiveRegion="polite">
          {l.successMessage}
        </Text>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={[{ flex: 1 }, style]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.root, contentContainerStyle]}
      >
        <Text style={styles.title}>{l.title}</Text>

        {errorMessage !== null && (
          <Text style={styles.error} accessibilityRole="alert">
            {errorMessage}
          </Text>
        )}

        <View>
          <Text style={styles.label}>{l.email}</Text>
          <TextInput
            testID="st-magic-link-email"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            editable={!loading}
            accessibilityLabel={l.email}
            placeholderTextColor={theme.colorTextMuted}
          />
        </View>

        <Pressable
          testID="st-magic-link-submit"
          accessibilityRole="button"
          disabled={loading}
          onPress={() => {
            void handleSubmit()
          }}
          style={[styles.button, loading ? styles.buttonDisabled : null]}
        >
          <Text style={styles.buttonText}>{loading ? "Sending…" : l.submit}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
