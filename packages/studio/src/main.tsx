import React, { useState, useEffect, useCallback } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { StudioApp } from "./StudioApp.js"
import { CloudAuth } from "./views/CloudAuth.js"
import { createClient } from "@supatype/client"
import { mockConfig } from "./fixtures/mockConfig.js"
import "./globals.css"

// Runtime cloud config injected by Docker entrypoint (see Dockerfile)
declare global {
  interface Window {
    __SUPATYPE_CLOUD__?: {
      controlPlaneUrl: string
    }
  }
}

const cloudCfg = window.__SUPATYPE_CLOUD__ ?? (
  import.meta.env.VITE_SUPATYPE_CLOUD_URL
    ? { controlPlaneUrl: import.meta.env.VITE_SUPATYPE_CLOUD_URL as string }
    : undefined
)
const isCloud = !!cloudCfg?.controlPlaneUrl

function decodeJwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!)) as { exp?: number }
    return payload.exp ?? null
  } catch { return null }
}

function App(): React.ReactElement {
  const [token, setToken] = useState<string | null>(() => {
    if (!isCloud) return null
    return localStorage.getItem("supatype_cloud_token")
  })
  const [tokenValid, setTokenValid] = useState<boolean | null>(isCloud ? null : true)

  // Parse OAuth callback tokens from URL
  useEffect(() => {
    if (!isCloud) return
    const params = new URLSearchParams(window.location.search)
    const urlToken = params.get("token")
    const urlRefresh = params.get("refreshToken")
    if (urlToken && urlRefresh) {
      localStorage.setItem("supatype_cloud_token", urlToken)
      localStorage.setItem("supatype_cloud_refresh_token", urlRefresh)
      setToken(urlToken)
      setTokenValid(true)
      // Clean the URL
      const url = new URL(window.location.href)
      url.searchParams.delete("token")
      url.searchParams.delete("refreshToken")
      window.history.replaceState({}, "", url.pathname + url.search + url.hash)
    }
  }, [])

  // Validate stored token on mount
  useEffect(() => {
    if (!isCloud || !token) {
      setTokenValid(!isCloud ? true : false)
      return
    }
    fetch(`${cloudCfg!.controlPlaneUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (res.ok) {
          setTokenValid(true)
        } else {
          localStorage.removeItem("supatype_cloud_token")
          localStorage.removeItem("supatype_cloud_refresh_token")
          setToken(null)
          setTokenValid(false)
        }
      })
      .catch(() => {
        // Can't reach control plane — use token optimistically
        setTokenValid(true)
      })
  }, [token])

  // Auto-refresh JWT before expiry
  useEffect(() => {
    if (!isCloud || !token) return

    const exp = decodeJwtExp(token)
    if (exp === null) return

    const msUntilRefresh = (exp * 1000) - Date.now() - (5 * 60 * 1000)
    if (msUntilRefresh <= 0) {
      // Token is already near expiry or expired — refresh now
      void refreshToken()
      return
    }

    const timer = setTimeout(() => {
      void refreshToken()
    }, msUntilRefresh)

    return () => clearTimeout(timer)

    async function refreshToken(): Promise<void> {
      const storedRefresh = localStorage.getItem("supatype_cloud_refresh_token")
      if (!storedRefresh) {
        clearTokens()
        return
      }
      try {
        const res = await fetch(`${cloudCfg!.controlPlaneUrl}/api/v1/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: storedRefresh }),
        })
        if (!res.ok) {
          clearTokens()
          return
        }
        const json = await res.json() as { data: { token: string; refreshToken: string } }
        localStorage.setItem("supatype_cloud_token", json.data.token)
        localStorage.setItem("supatype_cloud_refresh_token", json.data.refreshToken)
        setToken(json.data.token)
      } catch {
        clearTokens()
      }
    }

    function clearTokens(): void {
      localStorage.removeItem("supatype_cloud_token")
      localStorage.removeItem("supatype_cloud_refresh_token")
      setToken(null)
    }
  }, [token])

  const handleAuthenticated = useCallback((newToken: string, refreshToken: string) => {
    localStorage.setItem("supatype_cloud_token", newToken)
    localStorage.setItem("supatype_cloud_refresh_token", refreshToken)
    setToken(newToken)
    setTokenValid(true)
  }, [])

  // Cloud mode but no valid token — show login
  if (isCloud && (!token || tokenValid === false)) {
    return (
      <CloudAuth
        controlPlaneUrl={cloudCfg!.controlPlaneUrl}
        onAuthenticated={handleAuthenticated}
      />
    )
  }

  // Still validating token
  if (tokenValid === null) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    )
  }

  // Cloud mode: no config or client passed — derived from active project inside StudioApp
  if (isCloud) {
    return (
      <StudioApp
        controlPlaneUrl={cloudCfg!.controlPlaneUrl}
        cloudToken={token ?? undefined}
      />
    )
  }

  // Self-hosted mode: use local config + client
  const client = createClient({
    url: "http://localhost:8000",
    anonKey: "dev-anon-key",
  })

  return (
    <StudioApp
      config={mockConfig}
      client={client}
    />
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
