/**
 * Two auth flows nothing has ever run against a live server.
 *
 * MFA had a test, and it mocked every response, so it asserted the shape of the
 * requests the client sends and never that a server accepts them. Password reset
 * had nothing: the console mailer omits the body on purpose, so the token it
 * emails was not visible anywhere, and the token stored on the row is a hash.
 * This points the server at an SMTP catcher and reads the real message.
 *
 * Usage: bash tests/integration/scripts/auth-flows-e2e.sh
 */
import { createHmac } from "node:crypto"

const BASE = process.env.SUPATYPE_URL ?? "http://127.0.0.1:18473"
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:18025"
const ANON = process.env.ANON_KEY ?? ""
if (!ANON) throw new Error("ANON_KEY must be set")

let failures = 0
const ok = (m: string) => console.log(`  ok   ${m}`)
const bad = (m: string) => {
  console.error(`  FAIL ${m}`)
  failures++
}

const json = { "Content-Type": "application/json" }
const anon = { apikey: ANON, Authorization: `Bearer ${ANON}`, ...json }

async function post(path: string, body: unknown, headers: Record<string, string> = anon) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) })
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* not json */
  }
  return { status: res.status, body: parsed as Record<string, unknown> | null, text }
}

/** The payload half of a JWT, which is where the assurance level lives. */
function claims(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString("utf8"))
}

/** RFC 6238 TOTP, so the code offered is one the server will compute too. */
function totp(secretBase32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = ""
  for (const ch of secretBase32.replace(/=+$/, "").toUpperCase()) {
    const idx = alphabet.indexOf(ch)
    if (idx < 0) continue
    bits += idx.toString(2).padStart(5, "0")
  }
  const bytes = Buffer.from(
    (bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)),
  )

  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
  const digest = createHmac("sha1", bytes).update(counter).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const code =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3]
  return String(code % 1_000_000).padStart(6, "0")
}

async function signUp(email: string, password: string): Promise<string> {
  const res = await post("/auth/v1/signup", { email, password })
  const token = res.body?.["access_token"]
  if (typeof token !== "string") throw new Error(`signup failed (${res.status}): ${res.text.slice(0, 200)}`)
  return token
}

async function login(email: string, password: string) {
  return post("/auth/v1/token?grant_type=password", { email, password })
}

// ─── MFA ─────────────────────────────────────────────────────────────────────

async function mfa(): Promise<void> {
  console.log("-- MFA (TOTP), against a server rather than a mock")
  const email = `mfa-${Date.now()}@example.com`
  const password = "MfaPass123!"
  const jwt = await signUp(email, password)
  const asUser = { apikey: ANON, Authorization: `Bearer ${jwt}`, ...json }

  const enrolled = await post("/auth/v1/factors", { factor_type: "totp", friendly_name: "e2e" }, asUser)
  const factorId = enrolled.body?.["id"]
  const totpBlock = enrolled.body?.["totp"] as Record<string, unknown> | undefined
  const secret = totpBlock?.["secret"]
  if (typeof factorId !== "string" || typeof secret !== "string") {
    bad(`enrol returned no factor and secret (${enrolled.status}): ${enrolled.text.slice(0, 200)}`)
    return
  }
  ok(`enrolled a TOTP factor, secret issued (${secret.length} chars)`)

  const challenge = await post(`/auth/v1/factors/${factorId}/challenge`, {}, asUser)
  const challengeId = challenge.body?.["id"]
  if (typeof challengeId !== "string") {
    bad(`challenge returned no id (${challenge.status}): ${challenge.text.slice(0, 200)}`)
    return
  }
  ok("challenged the factor")

  const verified = await post(
    `/auth/v1/factors/${factorId}/verify`,
    { challenge_id: challengeId, code: totp(secret) },
    asUser,
  )
  const upgraded = verified.body?.["access_token"]
  if (typeof upgraded !== "string") {
    bad(`verify refused the generated code (${verified.status}): ${verified.text.slice(0, 200)}`)
    return
  }
  const aal = claims(upgraded)["aal"]
  if (aal === "aal2") ok("the code was accepted and the new token is aal2")
  else bad(`token after verify is aal=${String(aal)}, want aal2`)

  // A wrong code must not be accepted, or the factor is decoration.
  const wrong = await post(
    `/auth/v1/factors/${factorId}/challenge`,
    {},
    asUser,
  )
  const wrongChallenge = wrong.body?.["id"]
  if (typeof wrongChallenge === "string") {
    const refused = await post(
      `/auth/v1/factors/${factorId}/verify`,
      { challenge_id: wrongChallenge, code: "000000" },
      asUser,
    )
    if (refused.status >= 400) ok(`a wrong code is refused (${refused.status})`)
    else bad(`a wrong code was accepted (${refused.status})`)
  }

  // And a fresh login should now be aal1 until a second step is done.
  const again = await login(email, password)
  const freshToken = again.body?.["access_token"]
  if (typeof freshToken === "string") {
    const freshAal = claims(freshToken)["aal"]
    if (freshAal === "aal1") ok("a password login alone is aal1 while a factor is enrolled")
    else bad(`a password login is aal=${String(freshAal)}, want aal1`)
  }
}

// ─── Password reset ──────────────────────────────────────────────────────────

interface MailpitMessage {
  ID: string
}

async function latestMessageTo(email: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    if (res.ok) {
      const found = (await res.json()) as { messages?: MailpitMessage[] }
      const first = found.messages?.[0]
      if (first) {
        const full = await fetch(`${MAILPIT}/api/v1/message/${first.ID}`)
        const msg = (await full.json()) as { Text?: string; HTML?: string }
        return `${msg.Text ?? ""}\n${msg.HTML ?? ""}`
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`no message delivered to ${email} within 20s`)
}

async function passwordReset(): Promise<void> {
  console.log("-- password reset, with the real emailed token")
  const email = `reset-${Date.now()}@example.com`
  const oldPassword = "OldPass123!"
  const newPassword = "BrandNew456!"
  await signUp(email, oldPassword)

  const asked = await post("/auth/v1/recover", { email })
  if (asked.status !== 200) {
    bad(`recover returned ${asked.status}: ${asked.text.slice(0, 160)}`)
    return
  }
  ok("asked for a recovery email")

  let body: string
  try {
    body = await latestMessageTo(email)
  } catch (err) {
    bad((err as Error).message)
    return
  }
  // The link carries the *hash*, which is what the column on the row holds too,
  // and POST /verify takes it as `token_hash`. Passing it as `token` makes the
  // server hash it a second time, and the comparison then fails as otp_expired
  // however fresh the link is. GET /verify treats its `token` query parameter as
  // the hash, which is where the confusion comes from.
  const hash =
    body.match(/token_hash=([A-Za-z0-9_-]+)/)?.[1] ?? body.match(/token=([A-Za-z0-9_-]+)/)?.[1]
  if (!hash) {
    bad(`no token in the delivered email: ${body.slice(0, 200).replace(/\s+/g, " ")}`)
    return
  }
  ok(`took the token out of the delivered email (${hash.length} chars)`)

  // token_hash goes alone: adding email makes the server refuse with
  // "Only the token_hash and type should be provided".
  const verified = await post("/auth/v1/verify", { type: "recovery", token_hash: hash })
  const recoveryJwt = verified.body?.["access_token"]
  if (typeof recoveryJwt !== "string") {
    bad(`verify refused the emailed token (${verified.status}): ${verified.text.slice(0, 200)}`)
    return
  }
  ok("the emailed token was accepted")

  const changed = await fetch(`${BASE}/auth/v1/user`, {
    method: "PUT",
    headers: { apikey: ANON, Authorization: `Bearer ${recoveryJwt}`, ...json },
    body: JSON.stringify({ password: newPassword }),
  })
  if (!changed.ok) {
    bad(`setting the new password failed (${changed.status}): ${(await changed.text()).slice(0, 160)}`)
    return
  }
  ok("set a new password with the recovery session")

  const withNew = await login(email, newPassword)
  if (withNew.status === 200) ok("logged in with the new password")
  else bad(`the new password does not work (${withNew.status})`)

  const withOld = await login(email, oldPassword)
  if (withOld.status >= 400) ok(`the old password no longer works (${withOld.status})`)
  else bad(`the old password still works (${withOld.status}) — the reset did not take`)
}

async function main(): Promise<void> {
  await mfa()
  console.log("")
  await passwordReset()
  console.log("")
  if (failures > 0) {
    console.error(`FAILED: ${failures} assertion(s)`)
    process.exit(1)
  }
  console.log("PASSED: MFA and password reset both work against a running server")
  process.exit(0)
}

void main()
