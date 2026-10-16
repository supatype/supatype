import React from "react"
import { useSupatype } from "@supatype/react"
import { EmailLinkForm, type EmailLinkFormLabels, type EmailLinkFormProps } from "./EmailLinkForm.js"
import type { Filled } from "./formParts.js"

export type ForgotPasswordFormLabels = EmailLinkFormLabels
export type ForgotPasswordFormProps = EmailLinkFormProps

const DEFAULT_LABELS: Filled<ForgotPasswordFormLabels> = {
  title: "Reset your password",
  email: "Email address",
  submit: "Send reset password instructions",
  successMessage: "Check your email for the password reset link.",
}

/**
 * Asks the auth service to email a password reset link (`resetPasswordForEmail`, `POST /recover`).
 * Must be rendered inside a `<SupatypeProvider>`.
 *
 * The link signs the user in and the client emits `PASSWORD_RECOVERY`; render `UpdatePasswordForm`
 * when it does. `redirectTo` is where the link lands when it is on the site URL's host (or the auth
 * server's redirect allow list); otherwise the link lands on the site URL.
 *
 * @example
 * ```tsx
 * <ForgotPasswordForm redirectTo={`${window.location.origin}/reset`} />
 * ```
 */
export function ForgotPasswordForm(props: ForgotPasswordFormProps): React.ReactElement {
  const { auth } = useSupatype()
  const { redirectTo } = props
  return (
    <EmailLinkForm
      props={props}
      config={{
        inputId: "st-forgot-email",
        labels: DEFAULT_LABELS,
        busyLabel: "Sending reset instructions…",
        send: (email) => auth.resetPasswordForEmail(email, { redirectTo }),
      }}
    />
  )
}
