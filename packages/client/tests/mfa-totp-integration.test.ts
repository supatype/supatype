/**
 * Integration test — Task 89: MFA TOTP flow
 *
 * Tests: enroll -> QR code -> verify code -> login requires 2 steps ->
 * JWT aal2 -> unenroll -> single step.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { AuthClient } from "../src/auth.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

const GOTRUE_URL = "http://localhost:9999"
const HEADERS = { apikey: "test-anon-key", "Content-Type": "application/json" }

const FACTOR_ID = "factor-totp-001"
const CHALLENGE_ID = "challenge-001"
const TOTP_SECRET = "JBSWY3DPEHPK3PXP"

const RAW_USER = {
  id: "user-1",
  email: "mfa@example.com",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  app_metadata: { provider: "email" },
  user_metadata: {},
  role: "authenticated",
  factors: [] as Record<string, unknown>[],
}

function makeAal1Token(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({ sub: "user-1", aal: "aal1", amr: [{ method: "password" }] }),
  ).toString("base64url")
  return `${header}.${payload}.mock-sig`
}

function makeAal2Token(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      sub: "user-1",
      aal: "aal2",
      amr: [{ method: "password" }, { method: "totp" }],
    }),
  ).toString("base64url")
  return `${header}.${payload}.mock-sig`
}

function makeTokenResponse(overrides?: Record<string, unknown>) {
  return {
    access_token: makeAal1Token(),
    refresh_token: "refresh-token-abc",
    token_type: "bearer",
    expires_in: 3600,
    user: { ...RAW_USER },
    ...overrides,
  }
}

function mockFetch(body: unknown, ok = true, status?: number): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok,
    status: status ?? (ok ? 200 : 400),
    json: vi.fn().mockResolvedValue(body),
    headers: { get: () => null },
  })
}

function freshClient(): AuthClient {
  return new AuthClient(GOTRUE_URL, HEADERS)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Task 89 — MFA TOTP integration", () => {
  beforeEach(() => vi.restoreAllMocks())

  describe("Step 1 — Enroll TOTP factor", () => {
    it("calls POST /factors with factor_type=totp", async () => {
      // First sign in to have a session
      const client = freshClient()
      vi.stubGlobal("fetch", mockFetch(makeTokenResponse()))
      await client.signInWithPassword({ email: "mfa@example.com", password: "pass" })

      // Now mock the enroll response
      const enrollResponse = {
        id: FACTOR_ID,
        type: "totp",
        friendly_name: "My Authenticator",
        totp: {
          qr_code: "data:image/svg+xml;base64,PHN2Zy...",
          secret: TOTP_SECRET,
          uri: `otpauth://totp/Supatype:mfa@example.com?secret=${TOTP_SECRET}&issuer=Supatype`,
        },
      }
      const enrollFetch = mockFetch(enrollResponse)
      vi.stubGlobal("fetch", enrollFetch)

      const { data, error } = await client.mfa.enroll({
        factorType: "totp",
        friendlyName: "My Authenticator",
        issuer: "Supatype",
      })

      expect(error).toBeNull()
      expect(data).not.toBeNull()
      expect(data!.id).toBe(FACTOR_ID)
      expect(data!.type).toBe("totp")

      // Verify POST was sent to /factors
      const [url, opts] = enrollFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${GOTRUE_URL}/factors`)
      expect(opts.method).toBe("POST")
      const body = JSON.parse(opts.body as string) as Record<string, string>
      expect(body["factor_type"]).toBe("totp")
    })

    it("returns QR code and secret for TOTP enrollment", async () => {
      const client = freshClient()
      vi.stubGlobal("fetch", mockFetch(makeTokenResponse()))
      await client.signInWithPassword({ email: "mfa@example.com", password: "pass" })

      vi.stubGlobal("fetch", mockFetch({
        id: FACTOR_ID,
        type: "totp",
        friendly_name: "App",
        totp: {
          qr_code: "data:image/svg+xml;base64,PHN2Zy...",
          secret: TOTP_SECRET,
          uri: `otpauth://totp/Supatype:mfa@example.com?secret=${TOTP_SECRET}`,
        },
      }))

      const { data } = await client.mfa.enroll({ factorType: "totp" })

      expect(data!.totp).toBeDefined()
      expect(data!.totp!.qrCode).toContain("data:image/svg+xml")
      expect(data!.totp!.secret).toBe(TOTP_SECRET)
      expect(data!.totp!.uri).toContain("otpauth://totp/")
    })

    it("returns error when not authenticated", async () => {
      const client = freshClient()
      const { data, error } = await client.mfa.enroll({ factorType: "totp" })

      expect(data).toBeNull()
      expect(error).not.toBeNull()
      expect(error!.message).toContain("Not authenticated")
    })
  })

  describe("Step 2 — Verify TOTP code (challenge + verify)", () => {
    it("creates a challenge and verifies the TOTP code", async () => {
      const client = freshClient()
      vi.stubGlobal("fetch", mockFetch(makeTokenResponse()))
      await client.signInWithPassword({ email: "mfa@example.com", password: "pass" })

      // Mock challenge
      const challengeCall = mockFetch({
        id: CHALLENGE_ID,
        type: "totp",
        expires_at: Math.floor(Date.now() / 1000) + 300,
      })
      vi.stubGlobal("fetch", challengeCall)

      const challengeResult = await client.mfa.challenge({ factorId: FACTOR_ID })
      expect(challengeResult.error).toBeNull()
      expect(challengeResult.data!.id).toBe(CHALLENGE_ID)

      // Mock verify — returns AAL2 token
      const aal2Response = makeTokenResponse({
        access_token: makeAal2Token(),
      })
      aal2Response.user.factors = [
        { id: FACTOR_ID, factor_type: "totp", status: "verified", created_at: "", updated_at: "" },
      ]
      vi.stubGlobal("fetch", mockFetch(aal2Response))

      const verifyResult = await client.mfa.verify({
        factorId: FACTOR_ID,
        challengeId: CHALLENGE_ID,
        code: "123456",
      })

      expect(verifyResult.error).toBeNull()
      expect(verifyResult.data.session).not.toBeNull()
      expect(verifyResult.data.session!.accessToken).toBe(aal2Response.access_token)
    })

    it("challengeAndVerify is a single-call convenience", async () => {
      const client = freshClient()
      vi.stubGlobal("fetch", mockFetch(makeTokenResponse()))
      await client.signInWithPassword({ email: "mfa@example.com", password: "pass" })

      // First call is challenge, second is verify
      let callCount = 0
      const mockFn = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          // Challenge response
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: CHALLENGE_ID,
              type: "totp",
              expires_at: Math.floor(Date.now() / 1000) + 300,
            }),
            headers: { get: () => null },
          }
        }
        // Verify response
        return {
          ok: true,
          status: 200,
          json: async () => makeTokenResponse({ access_token: makeAal2Token() }),
          headers: { get: () => null },
        }
      })
      vi.stubGlobal("fetch", mockFn)

      const { data, error } = await client.mfa.challengeAndVerify({
        factorId: FACTOR_ID,
        code: "654321",
      })

      expect(error).toBeNull()
      expect(data.session).not.toBeNull()
      expect(mockFn).toHaveBeenCalledTimes(2)
    })
  })

  describe("Step 3 — Login requires two steps with MFA enrolled", () => {
    it("first step: password login returns AAL1 session", async () => {
      const client = freshClient()
      const aal1Response = makeTokenResponse()
      vi.stubGlobal("fetch", mockFetch(aal1Response))

      const { data } = await client.signInWithPassword({ email: "mfa@example.com", password: "pass" })

      expect(data.session).not.toBeNull()
      // Decode JWT to check AAL
      const parts = data.session!.accessToken.split(".")
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<string, string>
      expect(payload["aal"]).toBe("aal1")
    })

    it("second step: TOTP verification elevates to AAL2", async () => {
      const client = freshClient()
      vi.stubGlobal("fetch", mockFetch(makeTokenResponse()))
      await client.signInWithPassword({ email: "mfa@example.com", password: "pass" })

      // Challenge
      vi.stubGlobal("fetch", mockFetch({
        id: CHALLENGE_ID,
        type: "totp",
        expires_at: Math.floor(Date.now() / 1000) + 300,
      }))
      await client.mfa.challenge({ factorId: FACTOR_ID })

      // Verify — AAL2
      const aal2Token = makeAal2Token()
      vi.stubGlobal("fetch", mockFetch(makeTokenResponse({ access_token: aal2Token })))
      const { data } = await client.mfa.verify({
        factorId: FACTOR_ID,
        challengeId: CHALLENGE_ID,
        code: "123456",
      })

      expect(data.session).not.toBeNull()
      const parts = data.session!.accessToken.split(".")
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<string, unknown>
      expect(payload["aal"]).toBe("aal2")
      expect(payload["amr"]).toEqual(
        expect.arrayContaining([{ method: "password" }, { method: "totp" }]),
      )
    })
  })

  describe("Step 4 — getAuthenticatorAssuranceLevel", () => {
    it("returns aal1 before TOTP verification", async () => {
      const client = freshClient()
      vi.stubGlobal("fetch", mockFetch(makeTokenResponse()))
      await client.signInWithPassword({ email: "mfa@example.com", password: "pass" })

      // Mock getUser to return user without verified factors
      vi.stubGlobal("fetch", mockFetch({ ...RAW_USER, factors: [] }))

      const { data } = await client.mfa.getAuthenticatorAssuranceLevel()
      expect(data).not.toBeNull()
      expect(data!.currentLevel).toBe("aal1")
      expect(data!.currentAuthenticationMethods).toContain("password")
    })

    it("returns aal2 after TOTP verification", async () => {
      const client = freshClient()
      vi.stubGlobal("fetch", mockFetch(makeTokenResponse({ access_token: makeAal2Token() })))
      await client.signInWithPassword({ email: "mfa@example.com", password: "pass" })

      // Mock getUser to return user with verified factor
      vi.stubGlobal("fetch", mockFetch({
        ...RAW_USER,
        factors: [{ id: FACTOR_ID, factor_type: "totp", status: "verified", created_at: "", updated_at: "" }],
      }))

      const { data } = await client.mfa.getAuthenticatorAssuranceLevel()
      expect(data).not.toBeNull()
      expect(data!.currentLevel).toBe("aal2")
      expect(data!.currentAuthenticationMethods).toContain("password")
      expect(data!.currentAuthenticationMethods).toContain("totp")
    })

    it("returns error when not authenticated", async () => {
      const client = freshClient()
      const { data, error } = await client.mfa.getAuthenticatorAssuranceLevel()

      expect(data).toBeNull()
      expect(error).not.toBeNull()
    })
  })

  describe("Step 5 — Unenroll factor, back to single step", () => {
    it("calls DELETE /factors/:id to unenroll", async () => {
      const client = freshClient()
      vi.stubGlobal("fetch", mockFetch(makeTokenResponse({ access_token: makeAal2Token() })))
      await client.signInWithPassword({ email: "mfa@example.com", password: "pass" })

      const unenrollFetch = mockFetch({ id: FACTOR_ID })
      vi.stubGlobal("fetch", unenrollFetch)

      const { data, error } = await client.mfa.unenroll({ factorId: FACTOR_ID })

      expect(error).toBeNull()
      expect(data).not.toBeNull()
      expect(data!.id).toBe(FACTOR_ID)

      const [url, opts] = unenrollFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${GOTRUE_URL}/factors/${FACTOR_ID}`)
      expect(opts.method).toBe("DELETE")
    })

    it("after unenroll, listFactors returns empty", async () => {
      const client = freshClient()
      vi.stubGlobal("fetch", mockFetch(makeTokenResponse()))
      await client.signInWithPassword({ email: "mfa@example.com", password: "pass" })

      // Mock getUser returning no factors
      vi.stubGlobal("fetch", mockFetch({ ...RAW_USER, factors: [] }))

      const { data } = await client.mfa.listFactors()
      expect(data).not.toBeNull()
      expect(data!.totp).toHaveLength(0)
      expect(data!.phone).toHaveLength(0)
      expect(data!.all).toHaveLength(0)
    })
  })
})
