import React, { useState, type FormEvent, type InputHTMLAttributes } from "react"
import { transportFailure, type SupatypeError } from "@supatype/client"
import { errorProps, type AuthFormClassNames } from "./classNames.js"

/** The auth service's refusal, shown above the fields; nothing while there is none. */
function FormError({
  message,
  classNames,
}: {
  message: string | null
  classNames: AuthFormClassNames | undefined
}): React.ReactElement | null {
  if (message === null) return null
  return (
    <p role="alert" aria-live="polite" {...errorProps(classNames)}>
      {message}
    </p>
  )
}

/** The message a form shows in its place once the request has gone through. */
export function FormMessage({
  text,
  classNames,
}: {
  text: string
  classNames: AuthFormClassNames | undefined
}): React.ReactElement {
  return (
    <p role="status" aria-live="polite" className={classNames?.message}>
      {text}
    </p>
  )
}

export type FormFieldProps = {
  id: string
  label: string
  classNames: AuthFormClassNames | undefined
} & Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id">

/** One label and input pair, each carrying its `classNames` slot. */
export function FormField({ id, label, classNames, ...input }: FormFieldProps): React.ReactElement {
  return (
    <div className={classNames?.field}>
      <label className={classNames?.label} htmlFor={id}>{label}</label>
      <input className={classNames?.input} id={id} {...input} />
    </div>
  )
}

/** The words of a form's frame: its heading, its button, and the button while the request runs. */
export interface FormShellText {
  title: string
  submit: string
  busy: string
}

/**
 * The frame every form shares: heading, refusal, the form's own fields, then the submit button.
 *
 * `errorMessage` overrides the request's refusal text, for a form that words it differently.
 */
export function FormShell({ request, text, className, classNames, errorMessage, children }: {
  request: AuthSubmit
  text: FormShellText
  className: string | undefined
  classNames: AuthFormClassNames | undefined
  errorMessage?: string | null | undefined
  children: React.ReactNode
}): React.ReactElement {
  return (
    <form onSubmit={request.onSubmit} className={className} noValidate>
      <h2 className={classNames?.title}>{text.title}</h2>
      <FormError message={errorMessage ?? request.errorMessage} classNames={classNames} />
      {children}
      <button type="submit" className={classNames?.submit} disabled={request.loading}>
        {request.loading ? text.busy : text.submit}
      </button>
    </form>
  )
}

export interface AuthSubmit {
  loading: boolean
  /** The refusal to show, or null. */
  errorMessage: string | null
  /** True once the request has succeeded. */
  done: boolean
  onSubmit: (e: FormEvent<HTMLFormElement>) => void
}

export interface AuthSubmitHandlers<T> {
  onDone: (data: T) => void
  onError?: ((error: SupatypeError) => void) | undefined
}

type Settled<T> = { data: T; error: null } | { error: SupatypeError }

/** The request's answer, with a request that threw (the network, not the server) as its refusal. */
async function settle<T>(send: () => Promise<{ data: T; error: SupatypeError | null }>): Promise<Settled<T>> {
  try {
    const { data, error } = await send()
    return error === null ? { data, error } : { error }
  } catch (err) {
    return { error: transportFailure(err) }
  }
}

/**
 * Submit a form's one auth request: loading while it runs, then the refusal or `done`.
 *
 * A refusal keeps the form so the user can correct it; `onError` hears both a refusal and a request
 * that never reached the server. The app's own handlers run after the request, outside its error
 * handling, so a throw in `onSuccess` is not shown as the server's refusal.
 */
export function useAuthSubmit<T>(
  send: () => Promise<{ data: T; error: SupatypeError | null }>,
  handlers: AuthSubmitHandlers<T>,
): AuthSubmit {
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function run(): Promise<void> {
    setErrorMessage(null)
    setLoading(true)
    const result = await settle(send)
    setLoading(false)
    if (result.error !== null) {
      setErrorMessage(result.error.message)
      handlers.onError?.(result.error)
      return
    }
    setDone(true)
    handlers.onDone(result.data)
  }

  return { loading, errorMessage, done, onSubmit: (e) => { e.preventDefault(); void run() } }
}

/**
 * The form's labels: each one the app gives, else the default.
 *
 * A plain spread would let `labels={{ title: undefined }}` blank the heading out.
 */
export function withDefaults<T extends object>(defaults: Filled<T>, overrides: T | undefined): Filled<T> {
  const given = Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined)
  return { ...defaults, ...Object.fromEntries(given) }
}

/** Every label present and a string: `Required` keeps an explicit `| undefined`. */
export type Filled<T> = { [K in keyof T]-?: Exclude<T[K], undefined> }
