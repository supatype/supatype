import React, { useState, type FormEvent } from "react"
import type { Session, SupatypeError } from "@supatype/client"
import { useAuth } from "@supatype/react"

export interface SignUpFormLabels {
  title?: string | undefined
  email?: string | undefined
  password?: string | undefined
  submit?: string | undefined
  successMessage?: string | undefined
}

export interface SignUpFormProps {
  /** Called with the new session after a successful sign-up (or null if email confirmation is required). */
  onSuccess?: ((session: Session | null) => void) | undefined
  /** Called with the error returned by the auth service. */
  onError?: ((error: SupatypeError) => void) | undefined
  /** CSS class applied to the outermost <form> element. */
  className?: string | undefined
  /** Override display labels. */
  labels?: SignUpFormLabels | undefined
  /**
   * Additional metadata stored on the user's `user_metadata`.
   * Merge with any custom fields collected in the form.
   */
  metadata?: Record<string, unknown> | undefined
}

const DEFAULT_LABELS: Required<SignUpFormLabels> = {
  title: "Create account",
  email: "Email address",
  password: "Password",
  submit: "Create account",
  successMessage: "Check your email to confirm your account.",
}

/**
 * A minimal, accessible sign-up form that integrates with `useAuth()`.
 * Must be rendered inside a `<SupatypeProvider>`.
 *
 * @example
 * ```tsx
 * <SignUpForm
 *   onSuccess={(session) => {
 *     if (session) router.push('/dashboard')
 *     // else: show "check your email" state (email confirmation required)
 *   }}
 * />
 * ```
 */
export function SignUpForm({ onSuccess, onError, className, labels, metadata }: SignUpFormProps): React.ReactElement {
  const { signUp } = useAuth()
  const l = { ...DEFAULT_LABELS, ...labels }

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
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
          // Email confirmation required
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
      <p role="status" aria-live="polite">
        {l.successMessage}
      </p>
    )
  }

  return (
    <form onSubmit={(e) => { void handleSubmit(e) }} className={className} noValidate>
      <h2>{l.title}</h2>

      {errorMessage !== null && (
        <p role="alert" aria-live="polite" style={{ color: "red" }}>
          {errorMessage}
        </p>
      )}

      <div>
        <label htmlFor="st-signup-email">{l.email}</label>
        <input
          id="st-signup-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
        />
      </div>

      <div>
        <label htmlFor="st-signup-password">{l.password}</label>
        <input
          id="st-signup-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
        />
      </div>

      <button type="submit" disabled={loading}>
        {loading ? "Creating account…" : l.submit}
      </button>
    </form>
  )
}
