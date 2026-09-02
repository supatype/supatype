/**
 * A filtered subscription: told about the rows you asked for, and not the others.
 *
 * The unfiltered case cannot catch a filter that is dropped on the way to the
 * server, because a subscription that receives everything looks correct as long
 * as the row you were watching for is in the everything. So this asserts both
 * halves: the matching row arrives, and the non-matching one does not.
 *
 *   pnpm dev            # in one terminal
 *   pnpm verify:filter  # in another
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createClient } from "@supatype/client"

const KONG_PORT = process.env.SUPATYPE_KONG_PORT ?? "18473"
const URL = process.env.SUPATYPE_URL ?? `http://127.0.0.1:${KONG_PORT}`
/** How long to wait for the row that should arrive. */
const DEADLINE_MS = Number(process.env.REALTIME_VERIFY_DEADLINE_MS ?? 30_000)
/** How long to keep listening for the row that should not, after the first one. */
const QUIET_MS = Number(process.env.REALTIME_QUIET_MS ?? 5_000)

function anonKey(): string {
  const fromEnv = process.env.SUPATYPE_ANON_KEY ?? process.env.ANON_KEY
  if (fromEnv) return fromEnv
  const env = readFileSync(resolve(import.meta.dirname, ".env"), "utf8")
  const match = env.match(/^ANON_KEY=(.*)$/m)
  if (!match) throw new Error("no ANON_KEY in .env — run `supatype dev` first")
  return match[1].trim().replace(/^"|"$/g, "")
}

const key = anonKey()
const supatype = createClient({ url: URL, anonKey: key })

const WANTED = "wanted-author"
const IGNORED = "ignored-author"

const seen: string[] = []
let status = "never reported"

async function insert(author: string, body: string): Promise<void> {
  const res = await fetch(`${URL}/rest/v1/message`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ body, author }),
  })
  if (!res.ok) throw new Error(`insert for ${author} refused (${res.status}): ${await res.text()}`)
}

async function main(): Promise<void> {
  const sub = supatype.from("message").subscribe(
    (payload) => {
      const row = payload.new as { author?: string } | null
      if (row?.author) seen.push(row.author)
    },
    { event: "INSERT", filter: `author=eq.${WANTED}` },
  )
  sub.channel.subscribe((s) => {
    status = s
  })

  const by = Date.now() + 15_000
  while (status !== "SUBSCRIBED" && Date.now() < by) {
    await new Promise((r) => setTimeout(r, 100))
  }
  if (status !== "SUBSCRIBED") {
    console.error(`FAIL: the channel never subscribed (last status: ${status})`)
    process.exit(1)
  }
  console.log(`  subscribed with filter author=eq.${WANTED}`)

  // The one that should not arrive goes first, so it has the longest possible
  // time to arrive wrongly before the assertion is made.
  await insert(IGNORED, "should not be delivered")
  await insert(WANTED, "should be delivered")

  const deadline = Date.now() + DEADLINE_MS
  while (!seen.includes(WANTED) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!seen.includes(WANTED)) {
    console.error(`FAIL: the matching row never arrived within ${DEADLINE_MS}ms`)
    process.exit(1)
  }
  console.log("  the matching row arrived")

  // Keep listening: the point is what does *not* come, and it could still be in
  // flight behind the one that did.
  await new Promise((r) => setTimeout(r, QUIET_MS))
  sub.unsubscribe()

  if (seen.includes(IGNORED)) {
    console.error(
      `FAIL: the filter was not applied — a row by ${IGNORED} was delivered too.\n` +
        `      seen: ${JSON.stringify(seen)}`,
    )
    process.exit(1)
  }
  console.log(`  the non-matching row did not arrive (seen: ${JSON.stringify(seen)})`)
  console.log("PASS: the filter was applied on both sides")
  process.exit(0)
}

void main()
