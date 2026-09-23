/**
 * The two channel features that are not postgres_changes: broadcast and presence.
 *
 * Both go over the same socket as a change subscription and neither touches the
 * database, so a stack where replication is broken can still serve them, and a
 * stack where the socket is fine can still fail them. They are asserted
 * separately for that reason.
 *
 *   pnpm dev              # in one terminal
 *   pnpm verify:channels  # in another
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createClient } from "@supatype/client"

const KONG_PORT = process.env.SUPATYPE_KONG_PORT ?? "18473"
const URL = process.env.SUPATYPE_URL ?? `http://127.0.0.1:${KONG_PORT}`
const DEADLINE_MS = Number(process.env.REALTIME_VERIFY_DEADLINE_MS ?? 30_000)

function anonKey(): string {
  const fromEnv = process.env.SUPATYPE_ANON_KEY ?? process.env.ANON_KEY
  if (fromEnv) return fromEnv
  const env = readFileSync(resolve(import.meta.dirname, ".env"), "utf8")
  const match = env.match(/^ANON_KEY=(.*)$/m)
  if (!match) throw new Error("no ANON_KEY in .env — run `supatype dev` first")
  return match[1].trim().replace(/^"|"$/g, "")
}

const key = anonKey()

/** Two clients, because a feature that only works when sender and receiver are
 *  the same connection is not a feature anyone can use. */
const listener = createClient({ url: URL, anonKey: key })
const sender = createClient({ url: URL, anonKey: key })

function waitFor<T>(what: string, ms: number, register: (resolve: (v: T) => void) => void): Promise<T> {
  return new Promise<T>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${what} did not arrive within ${ms}ms`)), ms)
    register((v) => {
      clearTimeout(timer)
      res(v)
    })
  })
}

async function subscribed(client: ReturnType<typeof createClient>, name: string) {
  const channel = client.realtime.channel(name)
  const ready = waitFor<string>(`${name} SUBSCRIBED`, 15_000, (res) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") res(status)
    })
  })
  return { channel, ready }
}

async function main(): Promise<void> {
  let failures = 0

  // ── broadcast ──────────────────────────────────────────────────────────────
  {
    const room = "room:channels-verify"
    const rx = listener.realtime.channel(room)
    const got = waitFor<Record<string, unknown>>("the broadcast", DEADLINE_MS, (res) => {
      rx.onBroadcast("ping", (payload) => res(payload))
    })
    await waitFor<string>(`${room} SUBSCRIBED`, 15_000, (res) => {
      rx.subscribe((s) => {
        if (s === "SUBSCRIBED") res(s)
      })
    })

    const tx = sender.realtime.channel(room)
    await waitFor<string>(`${room} sender SUBSCRIBED`, 15_000, (res) => {
      tx.subscribe((s) => {
        if (s === "SUBSCRIBED") res(s)
      })
    })
    tx.broadcast("ping", { from: "sender", at: Date.now() })

    try {
      const payload = await got
      console.log(`  ok   broadcast reached the other client: ${JSON.stringify(payload)}`)
    } catch (err) {
      console.error(`  FAIL broadcast: ${(err as Error).message}`)
      failures++
    }
    rx.unsubscribe()
    tx.unsubscribe()
  }

  // ── presence ───────────────────────────────────────────────────────────────
  {
    const room = "presence:channels-verify"
    const rx = listener.realtime.channel(room)
    const joined = waitFor<unknown>("a presence join", DEADLINE_MS, (res) => {
      rx.onPresence((event) => {
        if (event.joins.length > 0) res(event.joins)
      })
    })
    await waitFor<string>(`${room} SUBSCRIBED`, 15_000, (res) => {
      rx.subscribe((s) => {
        if (s === "SUBSCRIBED") res(s)
      })
    })

    const tx = sender.realtime.channel(room)
    await waitFor<string>(`${room} sender SUBSCRIBED`, 15_000, (res) => {
      tx.subscribe((s) => {
        if (s === "SUBSCRIBED") res(s)
      })
    })
    tx.track({ who: "sender" })

    try {
      const joins = await joined
      console.log(`  ok   presence join seen by the other client: ${JSON.stringify(joins)}`)
    } catch (err) {
      console.error(`  FAIL presence: ${(err as Error).message}`)
      failures++
    }
    tx.untrack()
    rx.unsubscribe()
    tx.unsubscribe()
  }

  if (failures > 0) {
    console.error(`FAIL: ${failures} channel feature(s) did not deliver`)
    process.exit(1)
  }
  console.log("PASS: broadcast and presence both delivered between two clients")
  process.exit(0)
}

void main()
