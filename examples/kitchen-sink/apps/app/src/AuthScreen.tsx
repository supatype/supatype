import React, { useState } from "react"
import { LoginForm, OAuthButton, SignUpForm } from "@supatype/react-auth"
import { Button, Card, Note, Stack } from "./components/ui.js"

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

          <Card>
            <Stack gap={14}>
              {mode === "signUp" ? <SignUpForm /> : <LoginForm />}

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
            </Stack>
          </Card>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMode(mode === "signUp" ? "signIn" : "signUp")}
          >
            {mode === "signUp" ? "Already have an account? Sign in" : "Need an account? Sign up"}
          </Button>
        </Stack>
      </div>
    </main>
  )
}
