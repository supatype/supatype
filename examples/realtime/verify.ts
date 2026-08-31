/**
 * Prove a change in the database reaches a subscriber.
 *
 * Every other example already runs the realtime service, because realtime is on
 * by default, and none of them ever subscribed to anything. The most that was
 * ever shown was the gateway upgrading a WebSocket, and a socket that opens and
 * never delivers a row looks exactly like a working one until someone waits for
 * a message that does not come.
 *
 * So this waits, with a deadline, and exits non-zero when nothing arrives.
 *
 *   pnpm dev        # in one terminal
 *   pnpm verify     # in another
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createClient } from "@supatype/client"

const KONG_PORT = process.env.SUPATYPE_KONG_PORT ?? "18473"
const URL = process.env.SUPATYPE_URL ?? `http://127.0.0.1:${KONG_PORT}`
const DEADLINE_MS = Number(process.env.REALTIME_VERIFY_DEADLINE_MS ?? 30_000)

/** The anon key `supatype dev` writes next to this file. */
function anonKey(): string {
  const fromEnv = process.env.SUPATYPE_ANON_KEY ?? process.env.ANON_KEY
  if (fromEnv) return fromEnv
  const env = readFileSync(resolve(import.meta.dirname, ".env"), "utf8")
  const match = env.match(/^ANON_KEY=(.*)$/m)
  if (!match) throw new Error("no ANON_KEY in .env — run `supatype dev` first")
  return match[1].trim().replace(/^"|"$/g, "")
}

const supatype = createClient({ url: URL, anonKey: anonKey() })

/** The row shape, spelled out here because this script runs before `supatype dev`
 * has generated types on a fresh checkout. */
type Message = { id: string; body: string; author: string; created_at: string }

const body = `hello at ${new Date().toISOString()}`
let received: Record<string, unknown> | null = null
let status = "never reported"

const arrived = new Promise<void>((resolve) => {
  const sub = supatype.from("message").subscribe(
    (payload) => {
      // Only the row this run wrote, so a leftover row from an earlier run
      // cannot make a broken subscription look healthy.
      const row = payload.new as Partial<Message> | null
      if (row?.body === body) {
        received = row as Record<string, unknown>
        sub.unsubscribe()
        resolve()
      }
    },
    { event: "INSERT" },
  )

  // `.on()` only registers a listener; the socket opens here. Without this the
  // callback above is never called and the failure is a timeout with no clue.
  sub.channel.subscribe((s) => {
    status = s
  })
})

async function main(): Promise<void> {
  // Give the subscription time to be established before writing, or the insert
  // races the SUBSCRIBED reply and the event is missed for an uninteresting
  // reason.
  const subscribedBy = Date.now() + 15_000
  while (status !== "SUBSCRIBED" && Date.now() < subscribedBy) {
    await new Promise((r) => setTimeout(r, 100))
  }
  if (status !== "SUBSCRIBED") {
    console.error(`FAIL: the channel never subscribed (last status: ${status})`)
    process.exit(1)
  }
  console.log("  subscribed to public:message")

  const inserted = await fetch(`${URL}/rest/v1/message`, {
    method: "POST",
    headers: {
      apikey: anonKey(),
      Authorization: `Bearer ${anonKey()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ body, author: "verify.ts" }),
  })
  if (!inserted.ok) {
    console.error(`FAIL: the insert was refused (${inserted.status}): ${await inserted.text()}`)
    process.exit(1)
  }
  console.log("  inserted a row over REST")

  const timedOut = Symbol("timed out")
  const outcome = await Promise.race([
    arrived.then(() => "arrived" as const),
    new Promise<typeof timedOut>((r) => setTimeout(() => r(timedOut), DEADLINE_MS)),
  ])

  if (outcome === timedOut) {
    console.error(
      `FAIL: subscribed, wrote a row, and no INSERT arrived within ${DEADLINE_MS}ms.\n` +
        "      The socket was open the whole time, which is the failure this example exists to catch.",
    )
    process.exit(1)
  }

  console.log(`  received the INSERT: ${String(received?.["body"])}`)
  console.log("PASS: a write reached the subscriber")
  process.exit(0)
}

void main()
