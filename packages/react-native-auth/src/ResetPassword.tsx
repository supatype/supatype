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
import type { Session, SupatypeError } from "@supatype/client"
import { useSupatype } from "@supatype/react"
import { useAuthTheme } from "./theme.js"
import { fieldStyles } from "./styles.js"

export interface ResetPasswordLabels {
  requestTitle?: string | undefined
  email?: string | undefined
  requestSubmit?: string | undefined
  requestSuccess?: string | undefined
  updateTitle?: string | undefined
  password?: string | undefined
  updateSubmit?: string | undefined
}

export interface ResetPasswordProps {
  /**
   * When set (from a recovery deep link after the user is signed in via recovery),
   * shows the new-password form and calls `updateUser({ password })`.
   */
  mode?: "request" | "update" | undefined
  redirectTo?: string | undefined
  onRequestSent?: (() => void) | undefined
  onPasswordUpdated?: ((session: Session | null) => void) | undefined
  onError?: ((error: SupatypeError) => void) | undefined
  labels?: ResetPasswordLabels | undefined
  style?: StyleProp<ViewStyle> | undefined
  contentContainerStyle?: StyleProp<ViewStyle> | undefined
}

const DEFAULT_LABELS: Required<ResetPasswordLabels> = {
  requestTitle: "Reset password",
  email: "Email address",
  requestSubmit: "Send reset link",
  requestSuccess: "Check your email for a password reset link.",
  updateTitle: "Choose a new password",
  password: "New password",
  updateSubmit: "Update password",
}

export function ResetPassword({
  mode = "request",
  redirectTo,
  onRequestSent,
  onPasswordUpdated,
  onError,
  labels,
  style,
  contentContainerStyle,
}: ResetPasswordProps): React.ReactElement {
  const client = useSupatype()
  const theme = useAuthTheme()
  const styles = fieldStyles(theme)
  const l = { ...DEFAULT_LABELS, ...labels }

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function handleRequest(): Promise<void> {
    setErrorMessage(null)
    setLoading(true)
    try {
      const { error } = await client.auth.resetPasswordForEmail(
        email,
        redirectTo !== undefined ? { redirectTo } : undefined,
      )
      if (error !== null) {
        setErrorMessage(error.message)
        onError?.(error)
      } else {
        setSent(true)
        onRequestSent?.()
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleUpdate(): Promise<void> {
    setErrorMessage(null)
    setLoading(true)
    try {
      const { error } = await client.auth.updateUser({ password })
      if (error !== null) {
        setErrorMessage(error.message)
        onError?.(error)
        return
      }
      const { data } = await client.auth.getSession()
      onPasswordUpdated?.(data.session)
    } finally {
      setLoading(false)
    }
  }

  if (mode === "request" && sent) {
    return (
      <View style={[styles.root, style]} testID="st-reset-sent">
        <Text style={styles.muted} accessibilityLiveRegion="polite">
          {l.requestSuccess}
        </Text>
      </View>
    )
  }

  const isUpdate = mode === "update"

  return (
    <KeyboardAvoidingView
      style={[{ flex: 1 }, style]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.root, contentContainerStyle]}
      >
        <Text style={styles.title}>{isUpdate ? l.updateTitle : l.requestTitle}</Text>

        {errorMessage !== null && (
          <Text style={styles.error} accessibilityRole="alert">
            {errorMessage}
          </Text>
        )}

        {!isUpdate ? (
          <View>
            <Text style={styles.label}>{l.email}</Text>
            <TextInput
              testID="st-reset-email"
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
        ) : (
          <View>
            <Text style={styles.label}>{l.password}</Text>
            <TextInput
              testID="st-reset-password"
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              editable={!loading}
              accessibilityLabel={l.password}
              placeholderTextColor={theme.colorTextMuted}
            />
          </View>
        )}

        <Pressable
          testID="st-reset-submit"
          accessibilityRole="button"
          disabled={loading}
          onPress={() => {
            void (isUpdate ? handleUpdate() : handleRequest())
          }}
          style={[styles.button, loading ? styles.buttonDisabled : null]}
        >
          <Text style={styles.buttonText}>
            {loading
              ? "Please wait…"
              : isUpdate
                ? l.updateSubmit
                : l.requestSubmit}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
