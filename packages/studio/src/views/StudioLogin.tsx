"use client"

import React, { useState } from "react"

export interface StudioLoginProps {
  apiBaseUrl: string
  onSubmit(email: string, password: string): Promise<{ error: string | null }>
}

export function StudioLogin({ apiBaseUrl, onSubmit }: StudioLoginProps): React.ReactElement {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const result = await onSubmit(email.trim(), password)
      if (result.error) {
        setError(result.error)
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-lg font-semibold text-foreground">Sign in to Studio</h1>
          <p className="text-sm text-muted-foreground">
            Use an admin account for this project. Create one with{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">supatype admin create-user</code> or during{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">supatype push</code>.
          </p>
        </div>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="studio-login-email" className="text-sm font-medium text-foreground">
              Email
            </label>
            <input
              id="studio-login-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="studio-login-password" className="text-sm font-medium text-foreground">
              Password
            </label>
            <input
              id="studio-login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            />
          </div>
          {error !== null && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="text-center text-xs text-muted-foreground">
          API: <code className="rounded bg-muted px-1 py-0.5">{apiBaseUrl.replace(/\/$/, "")}</code>
        </p>
      </div>
    </div>
  )
}
