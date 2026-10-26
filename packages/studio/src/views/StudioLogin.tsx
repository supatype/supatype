"use client"

import React, { useState } from "react"
import { Button, Input } from "../components/ui.js"
import { providerLabel } from "../lib/studio-sign-in.js"

/** The ways Studio's sign-in page can sign somebody in, and what to say when it opens. */
export interface StudioSignIn {
  /** OAuth providers to offer, by the name `/authorize` takes. Empty offers email and password only. */
  providers: readonly string[]
  withPassword(email: string, password: string): Promise<{ error: string | null }>
  withProvider(provider: string): Promise<{ error: string | null }>
  /** A refusal to show when the page opens, such as a provider sign-in the server turned down. */
  initialError: string | null
}

export interface StudioLoginProps {
  apiBaseUrl: string
  signIn: StudioSignIn
}

type Attempt = (run: () => Promise<{ error: string | null }>) => Promise<void>

/** One sign-in at a time, and the refusal from the last one (or the page's opening one). */
function useAttempt(initialError: string | null): { error: string | null; busy: boolean; attempt: Attempt } {
  // Undefined until somebody tries, so a refusal that arrives after the first paint still shows.
  const [error, setError] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const attempt: Attempt = async (run) => {
    setError(null)
    setBusy(true)
    try {
      setError((await run()).error)
    } finally {
      setBusy(false)
    }
  }
  return { error: error === undefined ? initialError : error, busy, attempt }
}

type FieldProps = { id: string; label: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "className">

function Field({ id, label, ...input }: FieldProps): React.ReactElement {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <Input id={id} required {...input} />
    </div>
  )
}

/** What each way of signing in shares: whether a sign-in is running, and how to start one. */
interface AttemptState {
  busy: boolean
  attempt: Attempt
}

function PasswordForm({ state, withPassword }: { state: AttemptState; withPassword: StudioSignIn["withPassword"] }): React.ReactElement {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    void state.attempt(() => withPassword(email.trim(), password))
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field id="studio-login-email" label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Field id="studio-login-password" label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <Button type="submit" variant="primary" size="md" disabled={state.busy} className="w-full justify-center">
        {state.busy ? "Signing in..." : "Sign in"}
      </Button>
    </form>
  )
}

function ProviderButtons({ state, signIn }: { state: AttemptState; signIn: StudioSignIn }): React.ReactElement | null {
  if (signIn.providers.length === 0) return null
  return (
    <div className="space-y-2">
      <p className="text-center text-xs text-muted-foreground">or</p>
      {signIn.providers.map((provider) => (
        <Button
          key={provider}
          type="button"
          size="md"
          disabled={state.busy}
          className="w-full justify-center"
          onClick={() => void state.attempt(() => signIn.withProvider(provider))}
        >
          {`Continue with ${providerLabel(provider)}`}
        </Button>
      ))}
    </div>
  )
}

function LoginHeading(): React.ReactElement {
  return (
    <div className="space-y-1 text-center">
      <h1 className="text-lg font-semibold text-foreground">Sign in to Studio</h1>
      <p className="text-sm text-muted-foreground">
        Use an account with a Studio role for this project. Create one with{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">supatype admin create-user</code> or during{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">supatype push</code>.
      </p>
    </div>
  )
}

export function StudioLogin({ apiBaseUrl, signIn }: StudioLoginProps): React.ReactElement {
  const { error, busy, attempt } = useAttempt(signIn.initialError)
  const state: AttemptState = { busy, attempt }
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm space-y-6">
        <LoginHeading />
        <PasswordForm state={state} withPassword={signIn.withPassword} />
        <ProviderButtons state={state} signIn={signIn} />
        {error !== null && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <p className="text-center text-xs text-muted-foreground">
          API: <code className="rounded bg-muted px-1 py-0.5">{apiBaseUrl.replace(/\/$/, "")}</code>
        </p>
      </div>
    </div>
  )
}
