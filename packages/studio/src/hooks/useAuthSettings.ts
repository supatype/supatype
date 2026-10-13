import { useEffect, useState } from "react"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { studioGatewayHeaders } from "../lib/studio-gateway-headers.js"
import { useAdminClient } from "./useAdminClient.js"

/** What the auth server's public `GET /auth/v1/settings` reports: its effective configuration. */
export interface AuthSettings {
  /** Provider name to whether it is enabled, as the server spells it (`github`, `anonymous_users`). */
  external: Record<string, boolean>
  disable_signup: boolean
  mailer_autoconfirm: boolean
  phone_autoconfirm: boolean
  sms_provider: string
  saml_enabled: boolean
  passkeys_enabled: boolean
}

export interface AuthSettingsState {
  settings: AuthSettings | null
  error: string | null
  loading: boolean
}

function bool(value: unknown): boolean {
  return value === true
}

/** Read defensively: an older server omits fields, and an absent flag is an off one. */
export function normaliseAuthSettings(raw: unknown): AuthSettings {
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
  const externalRaw = typeof body["external"] === "object" && body["external"] !== null ? body["external"] : {}
  const external: Record<string, boolean> = {}
  for (const [name, enabled] of Object.entries(externalRaw as Record<string, unknown>)) external[name] = bool(enabled)
  return {
    external,
    disable_signup: bool(body["disable_signup"]),
    mailer_autoconfirm: bool(body["mailer_autoconfirm"]),
    phone_autoconfirm: bool(body["phone_autoconfirm"]),
    sms_provider: typeof body["sms_provider"] === "string" ? body["sms_provider"] : "",
    saml_enabled: bool(body["saml_enabled"]),
    passkeys_enabled: bool(body["passkeys_enabled"]),
  }
}

/** The project's auth settings as its auth server reports them, read through the admin client. */
export function useAuthSettings(): AuthSettingsState {
  const client = useAdminClient()
  const [state, setState] = useState<AuthSettingsState>({ settings: null, error: null, loading: true })

  useEffect(() => {
    let cancelled = false
    const answer = (next: AuthSettingsState) => {
      if (!cancelled) setState(next)
    }

    void (async () => {
      try {
        const res = await fetch(`${client.url}/auth/v1/settings`, {
          credentials: "include",
          headers: { ...studioGatewayHeaders(), ...studioAuthHeaders(client) },
        })
        if (!res.ok) {
          answer({ settings: null, error: `Could not read the auth settings (${res.status})`, loading: false })
          return
        }
        answer({ settings: normaliseAuthSettings(await res.json()), error: null, loading: false })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        answer({ settings: null, error: `Could not read the auth settings: ${message}`, loading: false })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [client])

  return state
}
