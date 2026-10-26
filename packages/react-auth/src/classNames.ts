import type React from "react"

/**
 * Class names for each element an auth form renders.
 *
 * The forms ship no stylesheet, so an app styles them with its own classes. `className` on the form
 * only reaches the outer `<form>`; without these slots a class-based design system cannot reach the
 * labels, inputs or button except through descendant selectors written for this one component.
 */
export interface AuthFormClassNames {
  /** The `<h2>` heading. */
  title?: string | undefined
  /** The error message shown when the auth service rejects the request. */
  error?: string | undefined
  /** The wrapper around each label and input pair. */
  field?: string | undefined
  /** Each `<label>`. */
  label?: string | undefined
  /** Each `<input>`. */
  input?: string | undefined
  /** The submit `<button>`. */
  submit?: string | undefined
  /**
   * The line a form shows in its place when done: `SignUpForm` awaiting confirmation,
   * `ForgotPasswordForm` and `MagicLinkForm` once the email is sent, `UpdatePasswordForm` once the
   * password is set.
   */
  message?: string | undefined
}

/** Applied to the error message only when the app gives it no class of its own. */
export const DEFAULT_ERROR_STYLE: React.CSSProperties = { color: "red" }

/** Props for the error element: the app's class when given, the default colour otherwise. */
export function errorProps(classNames: AuthFormClassNames | undefined): {
  className?: string
  style?: React.CSSProperties
} {
  const className = classNames?.error
  return className !== undefined ? { className } : { style: DEFAULT_ERROR_STYLE }
}
