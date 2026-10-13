/**
 * The edge kit's functions, called the way a client calls them: through the gateway.
 *
 * The example's README lists what each function exercises and ends with a manual checklist
 * ("all behave as labeled on the buttons"). Nothing ran that checklist, so a worker that stopped
 * injecting a key, a gate that let the anon key through, or a webhook that accepted any signature
 * would each have shipped with the example still compiling. Each check below is one row of that
 * table, asserted on what the function answered rather than on the status alone.
 *
 * Usage: bash tests/integration/scripts/edge-kit-e2e.sh (which starts the stack and sets the env).
 */
import { createHmac, randomUUID } from "node:crypto"

const BASE = process.env.SUPATYPE_URL ?? "http://127.0.0.1:18473"
const ANON = process.env.ANON_KEY ?? ""
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? ""
if (ANON === "") throw new Error("ANON_KEY must be set")
if (WEBHOOK_SECRET === "") throw new Error("WEBHOOK_SECRET must be set")

type Json = Record<string, unknown>

interface Reply {
  status: number
  body: Json | null
  text: string
}

let failures = 0
const ok = (m: string): void => console.log(`  ok   ${m}`)
const bad = (m: string): void => {
  console.error(`  FAIL ${m}`)
  failures++
}

function check(cond: boolean, pass: string, fail: string): void {
  if (cond) ok(pass)
  else bad(fail)
}

async function call(path: string, init: RequestInit = {}): Promise<Reply> {
  const res = await fetch(`${BASE}${path}`, init)
  const text = await res.text()
  let body: Json | null = null
  try {
    body = JSON.parse(text) as Json
  } catch {
    /* not JSON: the text is kept for the failure message */
  }
  return { status: res.status, body, text }
}

/** Headers a client sends: the anon key always, plus whichever bearer it holds. */
function headers(bearer: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: ANON,
    "Content-Type": "application/json",
    ...(bearer !== null && { Authorization: `Bearer ${bearer}` }),
    ...extra,
  }
}

function invoke(name: string, bearer: string | null, body?: string, extra?: Record<string, string>): Promise<Reply> {
  return call(`/functions/v1/${name}`, {
    method: "POST",
    headers: headers(bearer, extra),
    ...(body !== undefined && { body }),
  })
}

const describe = (r: Reply): string => `${r.status} ${r.text.slice(0, 200)}`

async function signUp(): Promise<string> {
  const email = `edge-kit-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`
  const res = await call("/auth/v1/signup", {
    method: "POST",
    headers: headers(ANON),
    body: JSON.stringify({ email, password: "edge-kit-e2e-password" }),
  })
  const token = res.body?.["access_token"]
  if (typeof token !== "string") throw new Error(`sign-up returned no session: ${describe(res)}`)
  return token
}

async function basicInvoke(): Promise<void> {
  console.log("\n==> ping and echo: a basic invoke, and a body that survives the trip")
  const ping = await invoke("ping", ANON)
  check(
    ping.status === 200 && ping.body?.["ok"] === true && ping.body["function"] === "ping" && ping.body["method"] === "POST",
    "ping answered as itself, with the method it was called with",
    `ping: ${describe(ping)}`,
  )

  const payload = { marker: randomUUID(), nested: { n: 7 } }
  const echo = await invoke("echo", ANON, JSON.stringify(payload))
  const echoed = echo.body?.["body"] as Json | undefined
  check(
    echo.status === 200 && echoed?.["marker"] === payload.marker && (echoed["nested"] as Json | undefined)?.["n"] === 7,
    "echo returned the JSON body it was sent",
    `echo: ${describe(echo)}`,
  )
}

async function envInjection(): Promise<void> {
  console.log("\n==> env-check: what the worker injects, and what it withholds")
  const env = await invoke("env-check", ANON)
  const b = env.body ?? {}
  check(env.status === 200, "env-check answered", `env-check: ${describe(env)}`)
  check(b["hasSupatypeUrl"] === true && b["hasAnonKey"] === true, "the API URL and anon key are injected", `missing URL or anon key: ${env.text}`)
  check(b["hasWebhookSecret"] === true, "functions/.env.local reached the function", `WEBHOOK_SECRET not injected: ${env.text}`)
  // The service-role gate: `functions.serviceRole` names write-note only, so this function must
  // not see the key. A worker that handed it to every route would pass every other check here.
  check(
    b["hasServiceRoleKey"] === false,
    "the service-role key is withheld from a function the config does not name",
    `env-check was given the service-role key: ${env.text}`,
  )
}

async function authGates(userToken: string): Promise<void> {
  console.log("\n==> auth-required: refused without a bearer and with the anon key, allowed signed in")
  const none = await invoke("auth-required", null)
  check(none.status === 401, "no bearer is refused with 401", `no bearer: ${describe(none)}`)

  const anon = await invoke("auth-required", ANON)
  check(
    anon.status === 401 && anon.body?.["error"] === "unauthorized",
    "the anon key is refused with 401",
    `anon bearer: ${describe(anon)}`,
  )

  const user = await invoke("auth-required", userToken)
  check(
    user.status === 200 && user.body?.["ok"] === true,
    "a signed-in user's JWT is accepted",
    `user bearer: ${describe(user)}`,
  )
}

async function restWrite(): Promise<void> {
  console.log("\n==> write-note: a PostgREST write from Deno, with the service-role key the config grants")
  const text = `edge-kit-e2e ${randomUUID()}`
  const write = await invoke("write-note", ANON, JSON.stringify({ text }))
  const note = write.body?.["note"] as Json | null | undefined
  check(
    write.status === 200 && note?.["body"] === text && typeof note["id"] === "string",
    "write-note inserted the row and returned it",
    `write-note: ${describe(write)}`,
  )
  if (typeof note?.["id"] !== "string") return

  // Read back as a client, not as the function: the row exists, and the model's `read: Public`
  // rule is what lets the anon role see it.
  const read = await call(`/rest/v1/note?id=eq.${note["id"]}&select=id,body`, { headers: headers(ANON) })
  const rows = JSON.parse(read.text) as unknown
  check(
    read.status === 200 && Array.isArray(rows) && rows.length === 1 && (rows[0] as Json)["body"] === text,
    "the row landed, and an anon client reads it through the model's public read rule",
    `reading the note back: ${describe(read)}`,
  )
}

async function webhook(): Promise<void> {
  console.log("\n==> webhook: the HMAC signature decides")
  const raw = JSON.stringify({ event: "edge-kit.e2e", id: randomUUID() })
  const good = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")
  const signed = await invoke("webhook", ANON, raw, { "x-webhook-signature": good })
  check(
    signed.status === 200 && (signed.body?.["received"] as Json | undefined)?.["event"] === "edge-kit.e2e",
    "a valid signature is accepted and the payload is parsed",
    `valid signature: ${describe(signed)}`,
  )

  const wrong = createHmac("sha256", `${WEBHOOK_SECRET}-wrong`).update(raw).digest("hex")
  const forged = await invoke("webhook", ANON, raw, { "x-webhook-signature": wrong })
  check(
    forged.status === 401 && forged.body?.["error"] === "invalid_signature",
    "a signature made with the wrong secret is refused",
    `wrong signature: ${describe(forged)}`,
  )

  const tampered = await invoke("webhook", ANON, raw.replace("e2e", "e2f"), { "x-webhook-signature": good })
  check(tampered.status === 401, "a body changed after signing is refused", `tampered body: ${describe(tampered)}`)

  const unsigned = await invoke("webhook", ANON, raw)
  check(unsigned.status === 401, "an unsigned request is refused", `no signature: ${describe(unsigned)}`)
}

async function main(): Promise<void> {
  console.log(`edge-kit functions at ${BASE}/functions/v1`)
  const userToken = await signUp()
  await basicInvoke()
  await envInjection()
  await authGates(userToken)
  await restWrite()
  await webhook()
  if (failures > 0) {
    console.error(`\n${failures} edge-kit check(s) failed`)
    process.exit(1)
  }
  console.log("\nevery edge-kit function behaves as its README says")
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
