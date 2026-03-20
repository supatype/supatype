import React, { useState, useEffect } from "react"
import { cn } from "../lib/utils.js"

interface Providers {
  github: boolean
  google: boolean
  email: boolean
}

interface CloudAuthProps {
  controlPlaneUrl: string
  onAuthenticated: (token: string, refreshToken: string) => void
}

function GitHubIcon(): React.ReactElement {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836a9.59 9.59 0 012.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
    </svg>
  )
}

function GoogleIcon(): React.ReactElement {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 001 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  )
}

export function CloudAuth({ controlPlaneUrl, onAuthenticated }: CloudAuthProps): React.ReactElement {
  const [mode, setMode] = useState<"login" | "signup">("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [providers, setProviders] = useState<Providers | null>(null)

  useEffect(() => {
    fetch(`${controlPlaneUrl}/api/v1/auth/providers`)
      .then((res) => res.json() as Promise<{ data: Providers }>)
      .then((json) => setProviders(json.data))
      .catch(() => {
        // Default to email-only if we can't fetch providers
        setProviders({ github: false, google: false, email: true })
      })
  }, [controlPlaneUrl])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const endpoint = mode === "login" ? "/api/v1/auth/login" : "/api/v1/auth/signup"
      const body = mode === "login"
        ? { email, password }
        : { email, password, name }

      const res = await fetch(`${controlPlaneUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      const json = await res.json() as { data?: { token: string; refreshToken: string }; message?: string; error?: string }

      if (!res.ok) {
        setError(json.message ?? json.error ?? "Something went wrong")
        return
      }

      if (json.data?.token) {
        localStorage.setItem("supatype_cloud_token", json.data.token)
        localStorage.setItem("supatype_cloud_refresh_token", json.data.refreshToken)
        onAuthenticated(json.data.token, json.data.refreshToken)
      }
    } catch {
      setError("Could not connect to the cloud service")
    } finally {
      setLoading(false)
    }
  }

  const hasOAuth = providers !== null && (providers.github || providers.google)
  const hasEmail = providers === null || providers.email

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="w-full max-w-sm p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-foreground">Supatype Cloud</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {mode === "login" ? "Sign in to your account" : "Create your account"}
          </p>
        </div>

        {providers !== null && hasOAuth && (
          <>
            <div className="space-y-3">
              {providers.github && (
                <a
                  href={`${controlPlaneUrl}/api/v1/auth/github`}
                  className={cn(
                    "flex items-center justify-center gap-2 w-full py-2.5 text-sm font-medium rounded-lg transition-colors",
                    "bg-card border border-border text-foreground hover:bg-accent",
                  )}
                >
                  <GitHubIcon />
                  Sign in with GitHub
                </a>
              )}
              {providers.google && (
                <a
                  href={`${controlPlaneUrl}/api/v1/auth/google`}
                  className={cn(
                    "flex items-center justify-center gap-2 w-full py-2.5 text-sm font-medium rounded-lg transition-colors",
                    "bg-card border border-border text-foreground hover:bg-accent",
                  )}
                >
                  <GoogleIcon />
                  Sign in with Google
                </a>
              )}
            </div>

            {hasEmail && (
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">or continue with email</span>
                </div>
              </div>
            )}
          </>
        )}

        {hasEmail && (
          <>
            <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
              {mode === "signup" && (
                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-foreground mb-1.5">Name</label>
                  <input
                    id="name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="Your name"
                  />
                </div>
              )}

              <div>
                <label htmlFor="email" className="block text-sm font-medium text-foreground mb-1.5">Email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="you@example.com"
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-foreground mb-1.5">Password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder={mode === "signup" ? "Min 8 characters" : "Your password"}
                />
              </div>

              {error && (
                <div className="p-3 bg-destructive/10 text-destructive text-sm rounded-lg">{error}</div>
              )}

              <button
                type="submit"
                disabled={loading}
                className={cn(
                  "w-full py-2.5 text-sm font-medium rounded-lg transition-colors",
                  "bg-primary text-primary-foreground hover:bg-primary/90",
                  loading && "opacity-50 cursor-not-allowed",
                )}
              >
                {loading ? "Please wait..." : mode === "login" ? "Sign in" : "Create account"}
              </button>
            </form>

            <p className="text-center text-sm text-muted-foreground mt-6">
              {mode === "login" ? "Don't have an account? " : "Already have an account? "}
              <button
                type="button"
                onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(null) }}
                className="text-primary hover:underline font-medium"
              >
                {mode === "login" ? "Sign up" : "Sign in"}
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
