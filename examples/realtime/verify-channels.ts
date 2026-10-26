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
import { createClient } from "./supatype/generated/client"

/** From `.env`, which `pnpm verify:channels` loads (see verify.ts). */
const KONG_PORT = process.env.SUPATYPE_KONG_PORT ?? "18473"
const URL = process.env.SUPATYPE_URL ?? `http://127.0.0.1:${KONG_PORT}`
const DEADLINE_MS = Number(process.env.REALTIME_VERIFY_DEADLINE_MS ?? 30_000)

function anonKey(): string {
  const fromEnv = process.env.SUPATYPE_ANON_KEY ?? process.env.ANON_KEY
  if (fromEnv) return fromEnv
  const env = readFileSync(resolve(import.meta.dirname, ".env"), "utf8")
  const match = env.match(/^ANON_KEY=(.*)$/m)
  if (!match) throw new Error("no ANON_KEY in .env: run `supatype dev` first")
  return match[1].trim().replace(/^"|"$/g, "")
}

const key = anonKey()

/** Two clients, because a feature that only works when sender and receiver are
 *  the same connection is not a feature anyone can use. */
const listener = createClient({ url: URL, anonKey: key })
const sender = createClient({ url: URL, anonKey: key })
/** Joins a room only after someone is already tracked in it. */
const latecomer = createClient({ url: URL, anonKey: key })

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function waitFor<T>(what: string, ms: number, register: (resolve: (v: T) => void) => void): Promise<T> {
  return new Promise<T>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${what} did not arrive within ${ms}ms`)), ms)
    register((v) => {
      clearTimeout(timer)
      res(v)
    })
  })
}

type Client = ReturnType<typeof createClient>
type Channel = ReturnType<Client["realtime"]["channel"]>

/** Subscribe `client` to `name` and wait for the server to accept the join. */
async function joined(client: Client, name: string): Promise<Channel> {
  const channel = client.realtime.channel(name)
  await waitFor<string>(`${name} SUBSCRIBED`, 15_000, (res) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") res(status)
    })
  })
  return channel
}

/** Run one check, printing ok or FAIL, and report whether it passed. */
async function check(name: string, run: () => Promise<string>): Promise<boolean> {
  try {
    console.log(`  ok   ${name}: ${await run()}`)
    return true
  } catch (err) {
    console.error(`  FAIL ${name}: ${errorText(err)}`)
    return false
  }
}

async function broadcastReachesTheOtherClient(): Promise<string> {
  const room = "room:channels-verify"
  const rx = listener.realtime.channel(room)
  const got = waitFor<Record<string, unknown>>("the broadcast", DEADLINE_MS, (res) => {
    rx.onBroadcast("ping", (payload) => res(payload))
  })
  await joined(listener, room)
  const tx = await joined(sender, room)
  tx.broadcast("ping", { from: "sender", at: Date.now() })
  try {
    return JSON.stringify(await got)
  } finally {
    rx.unsubscribe()
    tx.unsubscribe()
  }
}

async function presenceJoinReachesTheOtherClient(): Promise<string> {
  const room = "presence:channels-verify"
  const rx = listener.realtime.channel(room)
  const seen = waitFor<unknown>("a presence join", DEADLINE_MS, (res) => {
    rx.onPresence((event) => {
      if (event.joins.length > 0) res(event.joins)
    })
  })
  await joined(listener, room)
  const tx = await joined(sender, room)
  tx.track({ who: "sender" })
  try {
    return JSON.stringify(await seen)
  } finally {
    tx.untrack()
    rx.unsubscribe()
    tx.unsubscribe()
  }
}

/**
 * A client that joins after someone is tracked is told who is already there.
 *
 * The check above has its listener subscribed before anyone tracks, so it passed while every
 * newcomer to a lobby saw only the people who came after it.
 */
async function latecomerSeesWhoIsAlreadyHere(): Promise<string> {
  const room = "presence:channels-verify-latecomer"
  const early = await joined(sender, room)
  const tracked = waitFor<unknown>("the early member's own join", DEADLINE_MS, (res) => {
    early.onPresence((event) => {
      if (event.joins.length > 0) res(event.joins)
    })
  })
  early.track({ who: "early" })
  await tracked
  const rx = latecomer.realtime.channel(room)
  const state = waitFor<unknown>("who was already here", DEADLINE_MS, (res) => {
    rx.onPresence((event) => {
      if (event.joins.some((entry) => entry["who"] === "early")) res(event.joins)
    })
  })
  try {
    await joined(latecomer, room)
    return JSON.stringify(await state)
  } finally {
    early.untrack()
    rx.unsubscribe()
    early.unsubscribe()
  }
}

async function main(): Promise<void> {
  const results = [
    await check("broadcast reached the other client", broadcastReachesTheOtherClient),
    await check("presence join seen by the other client", presenceJoinReachesTheOtherClient),
    await check("a latecomer was told who was already here", latecomerSeesWhoIsAlreadyHere),
  ]
  const failures = results.filter((passed) => !passed).length
  if (failures > 0) {
    console.error(`FAIL: ${failures} channel feature(s) did not deliver`)
    process.exit(1)
  }
  console.log("PASS: broadcast and presence delivered between clients, including to a latecomer")
  process.exit(0)
}

void main()
