import React, { useState } from "react"
import {
  ForgotPasswordForm,
  LoginForm,
  MagicLinkForm,
  OAuthButton,
  SignUpForm,
  UpdatePasswordForm,
} from "@supatype/react-auth"
import { authForm, Button, Card, Note, Stack } from "./components/ui.js"

type AuthMode = "signUp" | "signIn" | "forgot" | "magic"

/**
 * Auth, using the prebuilt forms rather than a hand-rolled pair.
 *
 * `@supatype/react-auth` exists precisely so an app does not write its own email/password form, and
 * an example that writes one anyway leaves the package untested and teaches the longer way round.
 */
export function AuthScreen(): React.ReactElement {
  const [mode, setMode] = useState<AuthMode>("signUp")

  return (
    <AuthLayout>
      <Card>
        <Stack gap={14}>
          <AuthForm mode={mode} />
          {(mode === "signUp" || mode === "signIn") && <OAuthSection />}
        </Stack>
      </Card>
      <AuthLinks mode={mode} onPick={setMode} />
    </AuthLayout>
  )
}

/** The page around every auth form: the welcome and one card's width. */
function AuthLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <main className="ks-auth">
      <div className="ks-auth__card">
        <Stack gap={18}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22 }}>Welcome to the conference</h1>
            <p className="ks-muted ks-small" style={{ margin: "6px 0 0" }}>
              Sign in for the programme, the lobby and your ticket. Every model behind them refuses{" "}
              <code>anon</code> by its own access rule, so there is nothing to see first.
            </p>
          </div>
          {children}
        </Stack>
      </div>
    </main>
  )
}

/**
 * The form for each mode. The emailed links land on this origin, because Supatype serves this build;
 * the client reads the session a link carries on start.
 */
function AuthForm({ mode }: { mode: AuthMode }): React.ReactElement {
  switch (mode) {
    case "signUp": return <SignUpForm {...authForm} />
    case "signIn": return <LoginForm {...authForm} />
    case "forgot": return <ForgotPasswordForm {...authForm} redirectTo={window.location.origin} />
    case "magic": return <MagicLinkForm {...authForm} redirectTo={window.location.origin} />
  }
}

function OAuthSection(): React.ReactElement {
  const [oauthError, setOauthError] = useState<string | null>(null)
  return (
    <>
      <div className="ks-faint ks-small" style={{ textAlign: "center" }}>or</div>

      {/*
        The redirect comes back to this origin because Supatype serves this build: there is
        no second host to register with the provider, and the callback lands where the app
        already is. A provider not configured in the project answers with an error rather
        than a blank page, which is what onError surfaces.
      */}
      <OAuthButton
        provider="github"
        className="ks-btn"
        onError={(e) => setOauthError(e.message)}
      />
      {oauthError !== null && <Note tone="error">{oauthError}</Note>}
    </>
  )
}

const AUTH_LINKS: Record<AuthMode, Array<[AuthMode, string]>> = {
  signUp: [["signIn", "Already have an account? Sign in"]],
  signIn: [
    ["forgot", "Forgot password?"],
    ["magic", "Email me a sign-in link"],
    ["signUp", "Need an account? Sign up"],
  ],
  forgot: [["signIn", "Back to sign in"]],
  magic: [["signIn", "Back to sign in"]],
}

/** The ways between the forms: sign up or in, and from signing in to a reset or an emailed link. */
function AuthLinks({ mode, onPick }: { mode: AuthMode; onPick: (mode: AuthMode) => void }): React.ReactElement {
  return (
    <Stack gap={4}>
      {AUTH_LINKS[mode].map(([to, label]) => (
        <Button key={to} variant="ghost" size="sm" onClick={() => onPick(to)}>{label}</Button>
      ))}
    </Stack>
  )
}

/**
 * The landing for a password reset link.
 *
 * The link has already signed the user in; `usePasswordRecovery` in `App` says why, and until they
 * have chosen a new password the app shows this instead of the conference.
 */
export function PasswordRecoveryScreen({ onDone }: { onDone: () => void }): React.ReactElement {
  const [updated, setUpdated] = useState(false)
  return (
    <AuthLayout>
      <Card>
        <Stack gap={14}>
          <UpdatePasswordForm {...authForm} onSuccess={() => setUpdated(true)} />
          {updated && <Button variant="primary" onClick={onDone}>Continue to the conference</Button>}
        </Stack>
      </Card>
    </AuthLayout>
  )
}
