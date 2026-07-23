import { sha256 } from "@noble/hashes/sha2.js"
import { utf8ToBytes } from "@noble/hashes/utils.js"

/** RFC 7636 code_challenge_method value expected by GoTrue. */
export const PKCE_METHOD_S256 = "s256"

/**
 * Encode bytes as base64url without padding (RFC 7636).
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  const b64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64")
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Cryptographically random PKCE code_verifier (43 chars, unreserved alphabet). */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

/** S256 code_challenge = BASE64URL(SHA256(ASCII(code_verifier))). */
export function createCodeChallengeS256(verifier: string): string {
  return bytesToBase64Url(sha256(utf8ToBytes(verifier)))
}
