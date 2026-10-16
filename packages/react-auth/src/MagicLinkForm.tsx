import React from "react"
import { useSupatype } from "@supatype/react"
import { EmailLinkForm, type EmailLinkFormLabels, type EmailLinkFormProps } from "./EmailLinkForm.js"
import type { Filled } from "./formParts.js"

export type MagicLinkFormLabels = EmailLinkFormLabels
export type MagicLinkFormProps = EmailLinkFormProps

const DEFAULT_LABELS: Filled<MagicLinkFormLabels> = {
  title: "Sign in with a magic link",
  email: "Email address",
  submit: "Send magic link",
  successMessage: "Check your email for the magic link.",
}

/**
 * Emails the user a link that signs them in without a password (`signInWithOtp`, `POST /otp`).
 * Must be rendered inside a `<SupatypeProvider>`.
 *
 * Following the link signs the user in on `redirectTo` (honoured on the site URL's host or the auth
 * server's redirect allow list, else the site URL); the client reads the session from the URL on
 * start and `useAuth()` shows the user.
 *
 * @example
 * ```tsx
 * <MagicLinkForm redirectTo={window.location.origin} />
 * ```
 */
export function MagicLinkForm(props: MagicLinkFormProps): React.ReactElement {
  const { auth } = useSupatype()
  const { redirectTo } = props
  return (
    <EmailLinkForm
      props={props}
      config={{
        inputId: "st-magic-email",
        labels: DEFAULT_LABELS,
        busyLabel: "Sending magic link…",
        send: (email) => auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } }),
      }}
    />
  )
}
