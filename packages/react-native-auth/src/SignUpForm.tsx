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
import { useAuth } from "@supatype/react"
import { useAuthTheme } from "./theme.js"
import { fieldStyles } from "./styles.js"

export interface SignUpFormLabels {
  title?: string | undefined
  email?: string | undefined
  password?: string | undefined
  submit?: string | undefined
  successMessage?: string | undefined
}

export interface SignUpFormProps {
  onSuccess?: ((session: Session | null) => void) | undefined
  onError?: ((error: SupatypeError) => void) | undefined
  labels?: SignUpFormLabels | undefined
  metadata?: Record<string, unknown> | undefined
  style?: StyleProp<ViewStyle> | undefined
  contentContainerStyle?: StyleProp<ViewStyle> | undefined
}

const DEFAULT_LABELS: Required<SignUpFormLabels> = {
  title: "Create account",
  email: "Email address",
  password: "Password",
  submit: "Create account",
  successMessage: "Check your email to confirm your account.",
}

export function SignUpForm({
  onSuccess,
  onError,
  labels,
  metadata,
  style,
  contentContainerStyle,
}: SignUpFormProps): React.ReactElement {
  const { signUp } = useAuth()
  const theme = useAuthTheme()
  const styles = fieldStyles(theme)
  const l = { ...DEFAULT_LABELS, ...labels }

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  async function handleSubmit(): Promise<void> {
    setErrorMessage(null)
    setLoading(true)
    try {
      const { data, error } = await signUp({
        email,
        password,
        ...(metadata !== undefined && { options: { data: metadata } }),
      })
      if (error !== null) {
        setErrorMessage(error.message)
        onError?.(error)
      } else {
        if (data.session === null) {
          setConfirmed(true)
        }
        onSuccess?.(data.session)
      }
    } finally {
      setLoading(false)
    }
  }

  if (confirmed) {
    return (
      <View style={[styles.root, style]}>
        <Text style={styles.muted} accessibilityRole="text" accessibilityLiveRegion="polite">
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
          <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
            {errorMessage}
          </Text>
        )}

        <View>
          <Text style={styles.label}>{l.email}</Text>
          <TextInput
            testID="st-signup-email"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            textContentType="emailAddress"
            editable={!loading}
            accessibilityLabel={l.email}
            placeholderTextColor={theme.colorTextMuted}
          />
        </View>

        <View>
          <Text style={styles.label}>{l.password}</Text>
          <TextInput
            testID="st-signup-password"
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password-new"
            textContentType="newPassword"
            editable={!loading}
            accessibilityLabel={l.password}
            placeholderTextColor={theme.colorTextMuted}
          />
        </View>

        <Pressable
          testID="st-signup-submit"
          accessibilityRole="button"
          accessibilityLabel={l.submit}
          disabled={loading}
          onPress={() => {
            void handleSubmit()
          }}
          style={[styles.button, loading ? styles.buttonDisabled : null]}
        >
          <Text style={styles.buttonText}>{loading ? "Creating account…" : l.submit}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
