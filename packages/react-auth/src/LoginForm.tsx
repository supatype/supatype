import React, { useState, type FormEvent } from "react"
import type { Session, SupatypeError } from "@supatype/client"
import { useAuth } from "@supatype/react"
import { errorProps, type AuthFormClassNames } from "./classNames.js"

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

const DEFAULT_LABELS: Required<LoginFormLabels> = {
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
  const l = { ...DEFAULT_LABELS, ...labels }

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
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
    <form onSubmit={(e) => { void handleSubmit(e) }} className={className} noValidate>
      <h2 className={classNames?.title}>{l.title}</h2>

      {errorMessage !== null && (
        <p role="alert" aria-live="polite" {...errorProps(classNames)}>
          {errorMessage}
        </p>
      )}

      <div className={classNames?.field}>
        <label className={classNames?.label} htmlFor="st-login-email">{l.email}</label>
        <input
          className={classNames?.input}
          id="st-login-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
        />
      </div>

      <div className={classNames?.field}>
        <label className={classNames?.label} htmlFor="st-login-password">{l.password}</label>
        <input
          className={classNames?.input}
          id="st-login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
        />
      </div>

      <button type="submit" className={classNames?.submit} disabled={loading}>
        {loading ? "Signing in…" : l.submit}
      </button>
    </form>
  )
}
