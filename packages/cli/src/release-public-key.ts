/**
 * Minisign public key for CDN release verification.
 * Populated at publish via scripts/embed-release-pubkey.mjs (MINISIGN_PUBLIC_KEY secret),
 * or overridden at runtime with SUPATYPE_RELEASE_PUBLIC_KEY.
 */
export const EMBEDDED_RELEASE_PUBLIC_KEY = ""

export function releasePublicKey(): string {
  const fromEnv = process.env["SUPATYPE_RELEASE_PUBLIC_KEY"]?.trim()
  if (fromEnv) return fromEnv
  return EMBEDDED_RELEASE_PUBLIC_KEY.trim()
}
