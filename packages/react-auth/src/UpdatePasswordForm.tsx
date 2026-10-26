import React, { useState } from "react"
import type { SupatypeError, User } from "@supatype/client"
import { useSupatype } from "@supatype/react"
import type { AuthFormClassNames } from "./classNames.js"
import { FormField, FormShell, FormMessage, useAuthSubmit, withDefaults, type Filled } from "./formParts.js"

export interface UpdatePasswordFormLabels {
  title?: string | undefined
  password?: string | undefined
  submit?: string | undefined
  /** Shown in place of the form once the new password is set. */
  successMessage?: string | undefined
}

export interface UpdatePasswordFormProps {
  /** Called with the updated user once the new password is set. */
  onSuccess?: ((user: User) => void) | undefined
  /** Called with the error returned by the auth service. */
  onError?: ((error: SupatypeError) => void) | undefined
  /** CSS class applied to the outermost <form> element. */
  className?: string | undefined
  /** Override display labels. */
  labels?: UpdatePasswordFormLabels | undefined
  /** Class names for the elements inside the form, so an app can style them with its own classes. */
  classNames?: AuthFormClassNames | undefined
}

const DEFAULT_LABELS: Filled<UpdatePasswordFormLabels> = {
  title: "Set a new password",
  password: "New password",
  submit: "Update password",
  successMessage: "Your password has been updated.",
}

/**
 * Sets a new password for the signed-in user (`updateUser`, `PUT /user`).
 * Must be rendered inside a `<SupatypeProvider>`.
 *
 * The landing for a password reset link: the link signs the user in and the client emits
 * `PASSWORD_RECOVERY`, which `usePasswordRecovery` turns into state: show this form while it is active. With no session it reports
 * "Not authenticated" through `onError`.
 *
 * @example
 * ```tsx
 * const recovery = usePasswordRecovery()
 * if (recovery.active) return <UpdatePasswordForm onSuccess={recovery.finish} />
 * ```
 */
export function UpdatePasswordForm({ onSuccess, onError, className, classNames, labels }: UpdatePasswordFormProps): React.ReactElement {
  const { auth } = useSupatype()
  const l = withDefaults(DEFAULT_LABELS, labels)
  const [password, setPassword] = useState("")
  const onDone = ({ user }: { user: User | null }): void => { if (user !== null) onSuccess?.(user) }
  const request = useAuthSubmit(() => auth.updateUser({ password }), { onDone, onError })

  if (request.done) return <FormMessage text={l.successMessage} classNames={classNames} />

  return (
    <FormShell request={request} text={{ title: l.title, submit: l.submit, busy: "Updating password…" }} className={className} classNames={classNames}>
      <FormField
        id="st-update-password"
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
