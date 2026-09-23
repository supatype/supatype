import { describe, it, expect } from "vitest"
import {
  bytesToBase64Url,
  createCodeChallengeS256,
  generateCodeVerifier,
  PKCE_METHOD_S256,
} from "../src/pkce.js"

describe("pkce helpers", () => {
  it("exports s256 method constant", () => {
    expect(PKCE_METHOD_S256).toBe("s256")
  })

  it("generates a 43-char unreserved code_verifier", () => {
    const verifier = generateCodeVerifier()
    expect(verifier.length).toBe(43)
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/)
  })

  it("creates a stable S256 challenge", () => {
    // Known vector: SHA256("test") base64url
    const challenge = createCodeChallengeS256("test")
    expect(challenge).toBe("n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg")
    expect(challenge).toMatch(/^[A-Za-z0-9\-._~]+$/)
  })

  it("bytesToBase64Url strips padding", () => {
    expect(bytesToBase64Url(new Uint8Array([0xff, 0xee, 0xdd]))).toBe("_-7d")
  })
})
