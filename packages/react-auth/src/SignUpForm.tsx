import React, { useState } from "react"
import type { Session, SupatypeError } from "@supatype/client"
import { useAuth } from "@supatype/react"
import type { AuthFormClassNames } from "./classNames.js"
import { FormField, FormShell, FormMessage, useAuthSubmit, withDefaults, type Filled } from "./formParts.js"

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
  /** Class names for the elements inside the form, so an app can style them with its own classes. */
  classNames?: AuthFormClassNames | undefined
  /**
   * Additional metadata stored on the user's `user_metadata`.
   * Merge with any custom fields collected in the form.
   */
  metadata?: Record<string, unknown> | undefined
}

const DEFAULT_LABELS: Filled<SignUpFormLabels> = {
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
export function SignUpForm({ onSuccess, onError, className, classNames, labels, metadata }: SignUpFormProps): React.ReactElement {
  const { signUp } = useAuth()
  const l = withDefaults(DEFAULT_LABELS, labels)

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const options = metadata !== undefined ? { options: { data: metadata } } : {}
  const onDone = ({ session }: { session: Session | null }): void => {
    // No session: the project requires the email to be confirmed first.
    if (session === null) setConfirmed(true)
    onSuccess?.(session)
  }
  const request = useAuthSubmit(() => signUp({ email, password, ...options }), { onDone, onError })

  if (confirmed) {
    return <FormMessage text={l.successMessage} classNames={classNames} />
  }

  return (
    <FormShell request={request} text={{ title: l.title, submit: l.submit, busy: "Creating account…" }} className={className} classNames={classNames}>
      <FormField
        id="st-signup-email"
        label={l.email}
        classNames={classNames}
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={request.loading}
      />

      <FormField
        id="st-signup-password"
        label={l.password}
        classNames={classNames}
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={request.loading}
      />
    </FormShell>
  )
}
