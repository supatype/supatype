import React, { useState } from "react"
import type { SupatypeError } from "@supatype/client"
import type { AuthFormClassNames } from "./classNames.js"
import { FormField, FormShell, FormMessage, useAuthSubmit, withDefaults, type Filled } from "./formParts.js"

export interface EmailLinkFormLabels {
  title?: string | undefined
  email?: string | undefined
  submit?: string | undefined
  /** Shown in place of the form once the email is on its way. */
  successMessage?: string | undefined
}

/** Props shared by the forms that email the user a link: `ForgotPasswordForm` and `MagicLinkForm`. */
export interface EmailLinkFormProps {
  /** Where the emailed link sends the browser once the auth server has checked it. */
  redirectTo?: string | undefined
  /** Called with the address once the auth service has accepted the request. */
  onSuccess?: ((email: string) => void) | undefined
  /** Called with the error returned by the auth service. */
  onError?: ((error: SupatypeError) => void) | undefined
  /** CSS class applied to the outermost <form> element. */
  className?: string | undefined
  /** Override display labels. */
  labels?: EmailLinkFormLabels | undefined
  /** Class names for the elements inside the form, so an app can style them with its own classes. */
  classNames?: AuthFormClassNames | undefined
}

/** What one email-link form does: its input's id, its words, and the request it sends. */
export interface EmailLinkConfig {
  inputId: string
  labels: Filled<EmailLinkFormLabels>
  busyLabel: string
  send: (email: string) => Promise<{ data: unknown; error: SupatypeError | null }>
}

/** An email field and a submit button that send one request, then "check your email". */
export function EmailLinkForm({ props, config }: { props: EmailLinkFormProps; config: EmailLinkConfig }): React.ReactElement {
  const { onSuccess, onError, className, classNames } = props
  const l = withDefaults(config.labels, props.labels)
  const [email, setEmail] = useState("")
  const request = useAuthSubmit(() => config.send(email), { onDone: () => onSuccess?.(email), onError })

  if (request.done) return <FormMessage text={l.successMessage} classNames={classNames} />

  return (
    <FormShell request={request} text={{ title: l.title, submit: l.submit, busy: config.busyLabel }} className={className} classNames={classNames}>
      <FormField
        id={config.inputId}
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
