/**
 * Shared helpers for realtime integration tests.
 */

import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import { createClient, RealtimeClient, type ChannelStatus, type RealtimePayload } from "@supatype/client"

export const BASE_URL = process.env["SUPATYPE_URL"] ?? "http://localhost:54399"
export const ANON_KEY = process.env["SUPATYPE_ANON_KEY"] ?? ""
export const SERVICE_ROLE_KEY = process.env["SUPATYPE_SERVICE_ROLE_KEY"] ?? ""

/** CI-friendly latency budget (Phase 10.6 F15 targets 100ms on a warm local stack). */
export const REALTIME_LATENCY_MS = Number(process.env["REALTIME_LATENCY_MS"] ?? "5000")

export function requireKeys(): void {
  if (!ANON_KEY) {
    throw new Error("SUPATYPE_ANON_KEY is required for realtime integration tests")
  }
}

export function adminClient() {
  assert.ok(SERVICE_ROLE_KEY, "SUPATYPE_SERVICE_ROLE_KEY is required for realtime data setup")
  return createClient({
    url: BASE_URL,
    anonKey: ANON_KEY,
    serviceRoleKey: SERVICE_ROLE_KEY,
  })
}

export function anonClient() {
  return createClient({ url: BASE_URL, anonKey: ANON_KEY })
}

/** Realtime WS client authenticated as a specific user (JWT in query token). */
export function userRealtimeClient(accessToken: string): RealtimeClient {
  return new RealtimeClient(`${BASE_URL}/realtime/v1`, {
    apikey: accessToken,
  })
}

export async function signUpTestUser(label: string): Promise<{
  accessToken: string
  userId: string
  email: string
}> {
  const email = `rt-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`
  const password = "integration-test-password-12"
  const auth = anonClient()
  const { error: signUpError } = await auth.auth.signUp({ email, password })
  assert.ifError(signUpError)
  const { data, error: signInError } = await auth.auth.signInWithPassword({ email, password })
  assert.ifError(signInError)
  assert.ok(data.session?.accessToken, "expected accessToken after signIn")
  assert.ok(data.user?.id, "expected user id after signIn")
  return {
    accessToken: data.session!.accessToken!,
    userId: data.user!.id,
    email,
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForSubscribe(
  subscribe: (cb: (status: ChannelStatus) => void) => void,
  timeoutMs = 15_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`subscribe timed out after ${timeoutMs}ms`)), timeoutMs)
    subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer)
        resolve()
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer)
        reject(new Error(`subscribe failed: ${status}`))
      }
    })
  })
}

export async function waitForEvents<T>(
  getCount: () => number,
  min: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (getCount() < min && Date.now() < deadline) {
    await sleep(100)
  }
  assert.ok(getCount() >= min, `expected at least ${min} event(s), got ${getCount()}`)
}

export async function waitForQuiet<T>(
  getCount: () => number,
  quietMs = 1500,
): Promise<void> {
  const start = getCount()
  await sleep(quietMs)
  assert.equal(getCount(), start, `expected no new events during ${quietMs}ms quiet window`)
}

export type ChangeEvent = RealtimePayload<Record<string, unknown>>

export function newSubscriptionRow(subscriberId: string, externalId: string) {
  return {
    subscriber_id: subscriberId,
    externalId,
    planId: randomUUID(),
    status: "trialing" as const,
    billingPeriod: "monthly" as const,
    currentPeriodEnd: new Date(Date.now() + 86_400_000).toISOString(),
    unitAmount: "9.99",
  }
}
