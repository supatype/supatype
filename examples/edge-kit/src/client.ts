import { createClient, type AugmentedDatabase } from "@supatype/client"

const DEFAULT_GATEWAY = "http://localhost:18473"

/**
 * API base URL for the browser client.
 * Prefer env; never use the Vite dev origin (:5173) — that returns index.html for /functions/*.
 */
function resolveUrl(): string {
  const fromEnv = (import.meta.env.VITE_SUPATYPE_URL as string | undefined)?.trim()
  if (fromEnv) return fromEnv.replace(/\/$/, "")

  if (typeof window !== "undefined") {
    const { protocol, hostname, port, origin } = window.location
    // Direct Vite — talk to Kong (or same host via vite proxy)
    if (port === "5173") {
      return `${protocol}//${hostname}:18473`
    }
    // Proxied through Kong — same origin is correct
    if (origin) return origin.replace(/\/$/, "")
  }

  return DEFAULT_GATEWAY
}

function resolveAnonKey(): string {
  const key = ((import.meta.env.VITE_SUPATYPE_ANON_KEY as string | undefined) ?? "").trim()
  if (!key) {
    throw new Error(
      "Missing VITE_SUPATYPE_ANON_KEY. Run `pnpm keys`, then restart `pnpm dev`.",
    )
  }
  return key
}

export const gatewayUrl = resolveUrl()
export const anonKeyValue = resolveAnonKey()

export const client = createClient<AugmentedDatabase>({
  url: gatewayUrl,
  anonKey: anonKeyValue,
})
