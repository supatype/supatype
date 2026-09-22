import React, { useState } from "react"
import { LoginForm, OAuthButton, SignUpForm } from "@supatype/react-auth"

/**
 * Auth, using the prebuilt forms rather than a hand-rolled pair.
 *
 * `@supatype/react-auth` exists precisely so an app does not write its own email/password form, and
 * an example that writes one anyway leaves the package untested and teaches the longer way round.
 */
export function AuthScreen(): React.ReactElement {
  const [mode, setMode] = useState<"signIn" | "signUp">("signUp")
  const [oauthError, setOauthError] = useState<string | null>(null)

  return (
    <main className="ks-shell ks-shell--narrow">
      <h1>Kitchen Sink</h1>
      <p className="ks-muted">
        The attendee app. Sign in to reach the schedule, the lobby and your ticket — each model
        below refuses <code>anon</code> by its own access rule, so there is nothing to see first.
      </p>

      <div className="ks-card">
        {mode === "signUp" ? <SignUpForm /> : <LoginForm />}

        <p className="ks-muted">or</p>

        {/*
          The redirect comes back to this origin because Supatype serves this build: there is no
          second host to register with the provider, and the callback lands where the app already
          is. A provider not configured in the project answers with an error rather than a blank
          page, which is what onError surfaces.
        */}
        <OAuthButton
          provider="github"
          className="ks-ghost"
          onError={(e) => setOauthError(e.message)}
        />
        {oauthError !== null && <p className="ks-error">{oauthError}</p>}
      </div>

      <button className="ks-ghost" onClick={() => setMode(mode === "signUp" ? "signIn" : "signUp")}>
        {mode === "signUp" ? "Already have an account? Sign in" : "Need an account? Sign up"}
      </button>
    </main>
  )
}
