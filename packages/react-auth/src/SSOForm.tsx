import React, { useState } from "react"
import { SSO_PROVIDER, SupatypeError, ssoDomain, type AuthClient, type SignInWithSSOResult } from "@supatype/client"
import { useSupatype } from "@supatype/react"
import type { AuthFormClassNames } from "./classNames.js"
import { FormField, FormShell, FormMessage, useAuthSubmit, withDefaults, type Filled } from "./formParts.js"
import { useRedirectError } from "./useRedirectError.js"

export interface SSOFormLabels {
  title?: string | undefined
  email?: string | undefined
  submit?: string | undefined
  /** Shown in place of the form while the browser goes to the identity provider. */
  successMessage?: string | undefined
}

export interface SSOFormProps {
  /** Where the browser lands once the identity provider has signed the user in. */
  redirectTo?: string | undefined
  /** Called with the identity provider's URL as the browser is sent there. */
  onSuccess?: ((url: string) => void) | undefined
  /** Called with the error returned by the auth service, or the form's own refusal of the address. */
  onError?: ((error: SupatypeError) => void) | undefined
  /** CSS class applied to the outermost <form> element. */
  className?: string | undefined
  /** Override display labels. */
  labels?: SSOFormLabels | undefined
  /** Class names for the elements inside the form, so an app can style them with its own classes. */
  classNames?: AuthFormClassNames | undefined
}

const DEFAULT_LABELS: Filled<SSOFormLabels> = {
  title: "Sign in with SSO",
  email: "Work email",
  submit: "Continue with SSO",
  successMessage: "Redirecting to your identity provider…",
}

const NO_DOMAIN = "Enter your work email address."

/** Start SSO for the address typed, refusing one with no domain before the server is asked. */
function startSSO(auth: AuthClient, email: string, redirectTo: string | undefined): Promise<SignInWithSSOResult> {
  const domain = ssoDomain(email)
  if (domain === null) {
    const error = new SupatypeError({ message: NO_DOMAIN, code: "validation_failed" })
    return Promise.resolve({ data: { url: "" }, error })
  }
  return auth.signInWithSSO({ domain, ...(redirectTo !== undefined && { options: { redirectTo } }) })
}

/**
 * Signs the user in through their organisation's SAML identity provider, found by the domain of
 * the email they type (`signInWithSSO`, `POST /sso`). Must be rendered inside a `<SupatypeProvider>`.
 *
 * The browser goes to the identity provider and comes back signed in on `redirectTo` (honoured on
 * the site URL's host or the auth server's redirect allow list, else the site URL). A sign-in the
 * server refused on the way back is shown above the field and passed to `onError`.
 *
 * @example
 * ```tsx
 * <SSOForm redirectTo={window.location.origin} />
 * ```
 */
export function SSOForm(props: SSOFormProps): React.ReactElement {
  const { auth } = useSupatype()
  const { redirectTo, onSuccess, onError, className, classNames } = props
  const l = withDefaults(DEFAULT_LABELS, props.labels)
  const [email, setEmail] = useState("")
  const redirectError = useRedirectError(SSO_PROVIDER, onError)
  const request = useAuthSubmit(() => startSSO(auth, email, redirectTo), { onDone: (data) => onSuccess?.(data.url), onError })

  if (request.done) return <FormMessage text={l.successMessage} classNames={classNames} />

  return (
    <FormShell
      request={request}
      text={{ title: l.title, submit: l.submit, busy: "Redirecting…" }}
      className={className}
      classNames={classNames}
      errorMessage={request.errorMessage ?? redirectError?.message}
    >
      <FormField
        id="st-sso-email"
        label={l.email}
        classNames={classNames}
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={request.loading}
      />
    </FormShell>
  )
}
