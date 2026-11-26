"use client"

import React, { useCallback, useState } from "react"
import { CaptchaWidget } from "../components/CaptchaWidget.js"
import { Button, Input } from "../components/ui.js"
import type { CaptchaSettings } from "../lib/captcha.js"
import { providerLabel, type StudioSignInMethods } from "../lib/studio-sign-in.js"

/** The ways Studio's sign-in page can sign somebody in, and what to say when it opens. */
export interface StudioSignIn {
  /** Which ways to offer: email and password, SAML single sign-on, and OAuth providers by name. */
  methods: StudioSignInMethods
  /** `captchaToken` is the widget's answer, present when the project has captcha on. */
  withPassword(email: string, password: string, captchaToken: string | undefined): Promise<{ error: string | null }>
  withProvider(provider: string): Promise<{ error: string | null }>
  /** SAML single sign-on through the provider for the work email's domain. */
  withSSO(email: string, captchaToken: string | undefined): Promise<{ error: string | null }>
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

/** The captcha widget's answer. An answer is good for one request, so a request spends it. */
interface CaptchaAnswer {
  settings: CaptchaSettings
  /** Null until the widget has answered, and again once it has expired or been spent. */
  token: string | null
  /** Changes when the widget is to be drawn afresh. */
  round: number
  onToken(token: string | null): void
  spend(): void
}

/** The page's captcha answer, or null when the project has no captcha. */
function useCaptchaAnswer(settings: CaptchaSettings | null): CaptchaAnswer | null {
  const [token, setToken] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  const spend = useCallback(() => {
    setToken(null)
    setRound((r) => r + 1)
  }, [])
  return settings === null ? null : { settings, token, round, onToken: setToken, spend }
}

/** What each way of signing in shares: whether a sign-in is running, and how to start one. */
interface AttemptState {
  busy: boolean
  attempt: Attempt
  captcha: CaptchaAnswer | null
}

/** True while the project's captcha has not been answered: the server would refuse the request. */
function awaitingCaptcha(state: AttemptState): boolean {
  return state.captcha !== null && state.captcha.token === null
}

/** An attempt that carries the captcha answer and spends it, whatever the server said. */
async function attemptWithCaptcha(state: AttemptState, run: (captchaToken: string | undefined) => Promise<{ error: string | null }>): Promise<void> {
  const token = state.captcha?.token ?? undefined
  await state.attempt(() => run(token))
  state.captcha?.spend()
}

/** A part of the page that starts sign-ins: the shared attempt state and the page's ways in. */
interface AttemptProps {
  state: AttemptState
  signIn: StudioSignIn
}

function PasswordForm({ state, withPassword }: { state: AttemptState; withPassword: StudioSignIn["withPassword"] }): React.ReactElement {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    void attemptWithCaptcha(state, (captchaToken) => withPassword(email.trim(), password, captchaToken))
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field id="studio-login-email" label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Field id="studio-login-password" label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <Button type="submit" variant="primary" size="md" disabled={state.busy || awaitingCaptcha(state)} className="w-full justify-center">
        {state.busy ? "Signing in..." : "Sign in"}
      </Button>
    </form>
  )
}

/** SAML single sign-on: the work email's domain finds the identity provider. */
function SsoForm({ state, withSSO, primary }: { state: AttemptState; withSSO: StudioSignIn["withSSO"]; primary: boolean }): React.ReactElement {
  const [email, setEmail] = useState("")
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    void attemptWithCaptcha(state, (captchaToken) => withSSO(email.trim(), captchaToken))
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field id="studio-login-sso-email" label="Work email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Button type="submit" variant={primary ? "primary" : "secondary"} size="md" disabled={state.busy || awaitingCaptcha(state)} className="w-full justify-center">
        Sign in with SSO
      </Button>
    </form>
  )
}

function ProviderButtons({ state, signIn }: AttemptProps): React.ReactElement {
  return (
    <div className="space-y-2">
      {signIn.methods.providers.map((provider) => (
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

/**
 * Each way the project offers, with "or" between them. Email and password go when the project turns
 * email sign-in off (N-FF3), since the server would refuse them; SSO and OAuth stay.
 */
function SignInMethods({ state, signIn }: AttemptProps): React.ReactElement {
  const { password, sso, providers } = signIn.methods
  const sections = [
    password && <PasswordForm key="password" state={state} withPassword={signIn.withPassword} />,
    sso && <SsoForm key="sso" state={state} withSSO={signIn.withSSO} primary={!password} />,
    providers.length > 0 && <ProviderButtons key="providers" state={state} signIn={signIn} />,
  ].filter((section): section is React.ReactElement => section !== false)
  if (sections.length === 0) {
    return <p className="text-center text-sm text-muted-foreground">This project has no sign-in method Studio can offer.</p>
  }
  const { captcha } = state
  return (
    <>
      {/* One widget for the page: the server checks the password and SSO forms, not OAuth. */}
      {captcha !== null && (password || sso) && <CaptchaWidget captcha={captcha.settings} round={captcha.round} onToken={captcha.onToken} />}
      {sections.map((section, i) => (
        <React.Fragment key={section.key}>
          {i > 0 && <p className="text-center text-xs text-muted-foreground">or</p>}
          {section}
        </React.Fragment>
      ))}
    </>
  )
}

export function StudioLogin({ apiBaseUrl, signIn }: StudioLoginProps): React.ReactElement {
  const { error, busy, attempt } = useAttempt(signIn.initialError)
  const captcha = useCaptchaAnswer(signIn.methods.captcha)
  const state: AttemptState = { busy, attempt, captcha }
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm space-y-6">
        <LoginHeading />
        <SignInMethods state={state} signIn={signIn} />
        {error !== null && (
          <p className="text-sm text-destructive-text" role="alert">
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
