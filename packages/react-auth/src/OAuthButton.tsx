/**
 * OAuthButton component — Gap Appendices task 12
 *
 * Renders a styled sign-in button for an OAuth provider.
 * Handles the full OAuth flow via `useAuth().signInWithOAuth()`.
 *
 * @example
 * ```tsx
 * <OAuthButton provider="github" />
 * <OAuthButton provider="google" redirectTo="/dashboard" />
 * <OAuthButton provider="apple" className="dark-btn">Sign in with Apple</OAuthButton>
 * ```
 */

import React, { useState, type ReactNode } from "react"
import { useAuth } from "@supatype/react"

export interface OAuthButtonProps {
  /** OAuth provider name (e.g. "github", "google", "apple"). */
  provider: string
  /** URL to redirect to after successful authentication. */
  redirectTo?: string | undefined
  /** CSS class applied to the button element. */
  className?: string | undefined
  /** Override the button content. Defaults to "Sign in with {Provider}". */
  children?: ReactNode | undefined
  /** Called when the OAuth flow errors. */
  onError?: ((error: { message: string }) => void) | undefined
  /** Whether to open the OAuth URL in a popup instead of redirect. */
  popup?: boolean | undefined
  /** Button disabled state. */
  disabled?: boolean | undefined
}

/** Capitalise the first letter of a string. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Provider logo SVGs (inline to avoid external dependencies). */
const PROVIDER_ICONS: Record<string, string> = {
  github:
    '<svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
  google:
    '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>',
  apple:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.53-3.23 0-1.44.62-2.2.44-3.06-.4C3.79 16.17 4.36 9.33 8.93 9.07c1.23.07 2.09.72 2.81.77.99-.2 1.94-.78 3.01-.7 1.28.1 2.24.6 2.87 1.52-2.63 1.57-2 5.07.63 6.06-.5 1.3-.99 2.58-2.19 3.56zM12.03 9c-.12-2.08 1.55-3.82 3.47-3.97.26 2.29-2.07 4.01-3.47 3.97z"/></svg>',
}

/**
 * A pre-styled OAuth sign-in button with provider logo.
 *
 * Must be rendered inside a `<SupatypeProvider>`.
 */
export function OAuthButton({
  provider,
  redirectTo,
  className,
  children,
  onError,
  popup,
  disabled,
}: OAuthButtonProps): React.ReactElement {
  const { signInWithOAuth } = useAuth()
  const [loading, setLoading] = useState(false)

  const providerName = capitalize(provider)
  const iconSvg = PROVIDER_ICONS[provider.toLowerCase()]

  async function handleClick(): Promise<void> {
    setLoading(true)
    try {
      const { data, error } = await signInWithOAuth({
        provider,
        ...(redirectTo !== undefined && { options: { redirectTo } }),
      })

      if (error !== null) {
        onError?.(error)
        return
      }

      if (data.url) {
        if (popup === true) {
          const width = 500
          const height = 700
          const left = window.screenX + (window.outerWidth - width) / 2
          const top = window.screenY + (window.outerHeight - height) / 2
          window.open(
            data.url,
            `supatype-oauth-${provider}`,
            `width=${width},height=${height},left=${left},top=${top}`,
          )
        } else {
          window.location.href = data.url
        }
      }
    } catch (err) {
      onError?.({ message: err instanceof Error ? err.message : "OAuth failed" })
    } finally {
      setLoading(false)
    }
  }

  const defaultStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "10px 16px",
    border: "1px solid #d1d5db",
    borderRadius: "6px",
    backgroundColor: "#fff",
    color: "#374151",
    fontSize: "14px",
    fontWeight: 500,
    cursor: disabled === true || loading ? "not-allowed" : "pointer",
    opacity: disabled === true || loading ? 0.6 : 1,
    transition: "background-color 0.15s, border-color 0.15s",
    lineHeight: 1,
  }

  return (
    <button
      type="button"
      className={className}
      style={className !== undefined ? undefined : defaultStyle}
      onClick={() => { void handleClick() }}
      disabled={disabled === true || loading}
      aria-label={`Sign in with ${providerName}`}
    >
      {iconSvg !== undefined && (
        <span
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: iconSvg }}
          style={{ display: "inline-flex", alignItems: "center" }}
        />
      )}
      {children ?? (loading ? `Connecting to ${providerName}…` : `Sign in with ${providerName}`)}
    </button>
  )
}
