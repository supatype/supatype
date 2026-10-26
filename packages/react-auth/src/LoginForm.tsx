import React, { useState } from "react"
import type { Session, SupatypeError } from "@supatype/client"
import { useAuth } from "@supatype/react"
import type { AuthFormClassNames } from "./classNames.js"
import { FormField, FormShell, useAuthSubmit, withDefaults, type Filled } from "./formParts.js"

export interface LoginFormLabels {
  title?: string | undefined
  email?: string | undefined
  password?: string | undefined
  submit?: string | undefined
  errorPrefix?: string | undefined
}

export interface LoginFormProps {
  /** Called with the new session after a successful sign-in. */
  onSuccess?: ((session: Session) => void) | undefined
  /** Called with the error returned by the auth service. */
  onError?: ((error: SupatypeError) => void) | undefined
  /** CSS class applied to the outermost <form> element. */
  className?: string | undefined
  /** Override display labels. */
  labels?: LoginFormLabels | undefined
  /** Class names for the elements inside the form, so an app can style them with its own classes. */
  classNames?: AuthFormClassNames | undefined
}

const DEFAULT_LABELS: Filled<LoginFormLabels> = {
  title: "Sign in",
  email: "Email address",
  password: "Password",
  submit: "Sign in",
  errorPrefix: "",
}

/**
 * A minimal, accessible login form that integrates with `useAuth()`.
 * Must be rendered inside a `<SupatypeProvider>`.
 *
 * @example
 * ```tsx
 * <LoginForm
 *   onSuccess={(session) => router.push('/dashboard')}
 *   onError={(err) => console.error(err.message)}
 * />
 * ```
 */
export function LoginForm({ onSuccess, onError, className, classNames, labels }: LoginFormProps): React.ReactElement {
  const { signIn } = useAuth()
  const l = withDefaults(DEFAULT_LABELS, labels)

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const onDone = ({ session }: { session: Session | null }): void => { if (session !== null) onSuccess?.(session) }
  const request = useAuthSubmit(() => signIn({ email, password }), { onDone, onError })
  const errorMessage = request.errorMessage === null ? null : `${l.errorPrefix}${request.errorMessage}`

  return (
    <FormShell request={request} text={{ title: l.title, submit: l.submit, busy: "Signing in…" }} className={className} classNames={classNames} errorMessage={errorMessage}>
      <FormField
        id="st-login-email"
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
        id="st-login-password"
        label={l.password}
        classNames={classNames}
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={request.loading}
      />
    </FormShell>
  )
}
