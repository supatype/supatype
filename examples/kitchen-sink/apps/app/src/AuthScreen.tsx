import React, { useState } from "react"
import { LoginForm, SignUpForm } from "@supatype/react-auth"

/**
 * Auth, using the prebuilt forms rather than a hand-rolled pair.
 *
 * `@supatype/react-auth` exists precisely so an app does not write its own email/password form, and
 * an example that writes one anyway leaves the package untested and teaches the longer way round.
 */
export function AuthScreen(): React.ReactElement {
  const [mode, setMode] = useState<"signIn" | "signUp">("signUp")

  return (
    <main className="ks-shell ks-shell--narrow">
      <h1>Kitchen Sink</h1>
      <p className="ks-muted">
        The attendee app. Sign in to reach the schedule, the lobby and your ticket — each model
        below refuses <code>anon</code> by its own access rule, so there is nothing to see first.
      </p>

      <div className="ks-card">
        {mode === "signUp" ? <SignUpForm /> : <LoginForm />}
      </div>

      <button className="ks-ghost" onClick={() => setMode(mode === "signUp" ? "signIn" : "signUp")}>
        {mode === "signUp" ? "Already have an account? Sign in" : "Need an account? Sign up"}
      </button>
    </main>
  )
}
