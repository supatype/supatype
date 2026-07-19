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

export interface LoginFormLabels {
  title?: string | undefined
  email?: string | undefined
  password?: string | undefined
  submit?: string | undefined
  errorPrefix?: string | undefined
}

export interface LoginFormProps {
  onSuccess?: ((session: Session) => void) | undefined
  onError?: ((error: SupatypeError) => void) | undefined
  labels?: LoginFormLabels | undefined
  style?: StyleProp<ViewStyle> | undefined
  contentContainerStyle?: StyleProp<ViewStyle> | undefined
}

const DEFAULT_LABELS: Required<LoginFormLabels> = {
  title: "Sign in",
  email: "Email address",
  password: "Password",
  submit: "Sign in",
  errorPrefix: "",
}

export function LoginForm({
  onSuccess,
  onError,
  labels,
  style,
  contentContainerStyle,
}: LoginFormProps): React.ReactElement {
  const { signIn } = useAuth()
  const theme = useAuthTheme()
  const styles = fieldStyles(theme)
  const l = { ...DEFAULT_LABELS, ...labels }

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleSubmit(): Promise<void> {
    setErrorMessage(null)
    setLoading(true)
    try {
      const { data, error } = await signIn({ email, password })
      if (error !== null) {
        const msg = `${l.errorPrefix}${error.message}`
        setErrorMessage(msg)
        onError?.(error)
      } else if (data.session !== null) {
        onSuccess?.(data.session)
      }
    } finally {
      setLoading(false)
    }
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
            testID="st-login-email"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            editable={!loading}
            accessibilityLabel={l.email}
            placeholderTextColor={theme.colorTextMuted}
          />
        </View>

        <View>
          <Text style={styles.label}>{l.password}</Text>
          <TextInput
            testID="st-login-password"
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password"
            textContentType="password"
            editable={!loading}
            accessibilityLabel={l.password}
            placeholderTextColor={theme.colorTextMuted}
          />
        </View>

        <Pressable
          testID="st-login-submit"
          accessibilityRole="button"
          accessibilityLabel={l.submit}
          accessibilityState={{ disabled: loading }}
          disabled={loading}
          onPress={() => {
            void handleSubmit()
          }}
          style={[styles.button, loading ? styles.buttonDisabled : null]}
        >
          <Text style={styles.buttonText}>{loading ? "Signing in…" : l.submit}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
