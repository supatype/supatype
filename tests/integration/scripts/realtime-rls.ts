/**
 * Who receives a row, rather than whether any row is received.
 *
 * `examples/realtime/verify.ts` subscribes with the anon key to a public table and proves a write
 * reaches a subscriber. That is delivery. It says nothing about the question every multi-tenant
 * deployment depends on: that a change to one user's row is not delivered to another user.
 *
 * Realtime decodes the WAL from a replication slot, so it sees every change to every table in the
 * database regardless of what any subscriber is allowed to read. Nothing in Postgres is filtering
 * on the way out. `RlsFilter.visibleChange` is the only thing standing between a subscriber and
 * every other tenant's rows, which makes it worth an assertion rather than a reading.
 *
 * The shape of the test matters more than the count. A leak test that waits for a row that never
 * comes is passed by a realtime service that is simply broken, and passed just as well by a
 * network that dropped the socket. So the run writes two rows in order: one owned by a stranger,
 * then one owned by the subscriber. The second is a fence. When it arrives, the first has had
 * strictly longer to arrive and did not, and the pipe is proven live by the same event that closes
 * the window.
 *
 * Rows are recognised by a marker in `metadata`, which is text and survives a JSON round trip
 * intact. An earlier version keyed off `externalId`, a bigint, and the fence went unrecognised
 * because the value came back rounded. That is a real defect and it is asserted separately at the
 * end, but identifying rows by a value the transport is suspected of damaging turns one bug into a
 * failure to measure anything at all.
 */
import { createClient } from "@supatype/client"

const PORT = process.env["SUPATYPE_KONG_PORT"] ?? "18473"
const BASE = process.env["SUPATYPE_URL"] ?? `http://127.0.0.1:${PORT}`
const ANON = process.env["ANON_KEY"] ?? ""
const SERVICE = process.env["SERVICE_ROLE_KEY"] ?? ""
if (!ANON || !SERVICE) throw new Error("ANON_KEY and SERVICE_ROLE_KEY must be set")

const SUBSCRIBE_TIMEOUT_MS = Number(process.env["REALTIME_RLS_SUBSCRIBE_MS"] ?? 20_000)
const FENCE_TIMEOUT_MS = Number(process.env["REALTIME_RLS_FENCE_MS"] ?? 45_000)

let failures = 0
const ok = (m: string): void => console.log(`  ok   ${m}`)
const bad = (m: string, detail = ""): void => {
  failures++
  console.error(`  FAIL ${m}${detail ? ` - ${detail}` : ""}`)
}
const check = (cond: boolean, m: string, detail = ""): void => (cond ? ok(m) : bad(m, detail))

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Row = Record<string, unknown>

/** The marker this run stamps into `metadata`, so a leftover row cannot be taken for its own. */
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const STRANGER_MARK = `${RUN}-stranger`
const FENCE_MARK = `${RUN}-fence`

/** The marker a delivered row carries, whatever shape `metadata` arrives in. */
function markOf(row: Row): string | undefined {
  const meta = row["metadata"]
  if (meta !== null && typeof meta === "object") {
    const probe = (meta as Record<string, unknown>)["probe"]
    return typeof probe === "string" ? probe : undefined
  }
  // jsonb can arrive in its text form depending on the decoder, so that case is handled rather
  // than assumed away.
  if (typeof meta === "string") {
    try {
      const probe = (JSON.parse(meta) as Record<string, unknown>)["probe"]
      return typeof probe === "string" ? probe : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/** A REST call as the service role, which is how rows are seeded past the policies. */
async function asService(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

type Client = ReturnType<typeof createClient>

/** A signed-in client, and the user id its token carries. */
async function signedInClient(label: string): Promise<{ client: Client; id: string }> {
  const client = createClient({ url: BASE, anonKey: ANON })
  const email = `rt-${label}-${RUN}@example.test`
  const { data, error } = await client.auth.signUp({ email, password: "Correct-Horse-9" })
  const id = data?.user?.id
  if (error || typeof id !== "string") {
    throw new Error(`signup failed for ${label}: ${error ? error.message : "no user id"}`)
  }
  return { client, id }
}

/** Every `subscription` INSERT this client is handed, in arrival order. */
function collectInserts(client: Client): { rows: Row[]; ready: Promise<boolean>; stop: () => void } {
  const rows: Row[] = []
  const sub = client.from("subscription").subscribe(
    (payload) => {
      const row = payload.new as Row | null
      if (row) rows.push(row)
    },
    { event: "INSERT" },
  )

  // `.subscribe()` above only registers the handler. This opens the socket, and without waiting
  // for SUBSCRIBED the seeds below race the handshake and a miss would mean nothing.
  const ready = new Promise<boolean>((resolve) => {
    const deadline = setTimeout(() => resolve(false), SUBSCRIBE_TIMEOUT_MS)
    sub.channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(deadline)
        resolve(true)
      }
    })
  })

  return { rows, ready, stop: () => sub.unsubscribe() }
}

/**
 * Odd and past 2^53, so it is not representable as a double.
 *
 * Every odd value above 2^53 rounds to an even neighbour the moment it passes through a JSON
 * number, which is what makes it a probe rather than a constant. Unique per run because the
 * column is unique.
 */
const FENCE_EXTERNAL_ID = String(9007199254740993n + BigInt(Date.now() % 1_000_000) * 2n)

function subscriptionRow(subscriberId: string, externalId: string, mark: string): Row {
  return {
    subscriber_id: subscriberId,
    externalId,
    planId: "00000000-0000-0000-0000-000000000001",
    currentPeriodEnd: new Date(Date.now() + 86_400_000).toISOString(),
    unitAmount: "10.00",
    metadata: { probe: mark },
  }
}

async function main(): Promise<void> {
  console.log("-- two signed-in users, one table with an owner policy")
  const mine = await signedInClient("mine")
  const theirs = await signedInClient("theirs")
  check(mine.id !== theirs.id, "two sign-ups produce two distinct users")

  for (const user of [mine, theirs]) {
    const author = await asService("/rest/v1/author", {
      id: user.id,
      email: `rt-${user.id.slice(0, 8)}@example.test`,
      username: `r${user.id.slice(0, 8)}`,
    })
    if (author.status >= 300) {
      bad("could not seed an author", `HTTP ${author.status}: ${author.text.slice(0, 160)}`)
      process.exit(1)
    }
  }

  // A third subscriber holding no session at all. `visibleChange` returns null for absent claims,
  // so this asserts that branch against a running service rather than against the source.
  const anon = createClient({ url: BASE, anonKey: ANON })

  const mineFeed = collectInserts(mine.client)
  const anonFeed = collectInserts(anon)

  check(await mineFeed.ready, "a signed-in subscriber reaches SUBSCRIBED")
  // Not asserted either way: an anon socket may legitimately be refused the channel outright,
  // which is a stricter outcome than being subscribed and sent nothing. Both are accepted below.
  const anonSubscribed = await anonFeed.ready

  console.log("")
  console.log("-- a stranger's row, then the subscriber's own as a fence")

  // The stranger's row is committed first, so it has strictly longer to arrive than the fence. If
  // it is ever delivered, it is delivered before the fence, and the assertion below is not a guess
  // about how long to wait.
  const stranger = await asService(
    "/rest/v1/subscription",
    subscriptionRow(theirs.id, String(Date.now()), STRANGER_MARK),
  )
  check(
    stranger.status < 300,
    "a row owned by another user is written",
    `HTTP ${stranger.status}: ${stranger.text.slice(0, 160)}`,
  )

  await sleep(250)

  const fence = await asService(
    "/rest/v1/subscription",
    subscriptionRow(mine.id, FENCE_EXTERNAL_ID, FENCE_MARK),
  )
  check(
    fence.status < 300,
    "a row owned by the subscriber is written",
    `HTTP ${fence.status}: ${fence.text.slice(0, 160)}`,
  )

  const isFence = (r: Row): boolean => markOf(r) === FENCE_MARK
  const sawFenceBy = Date.now() + FENCE_TIMEOUT_MS
  while (!mineFeed.rows.some(isFence) && Date.now() < sawFenceBy) await sleep(200)

  const arrived = mineFeed.rows.some(isFence)
  check(
    arrived,
    "the subscriber receives their own row",
    `waited ${FENCE_TIMEOUT_MS}ms, saw ${mineFeed.rows.length} insert(s)`,
  )

  if (!arrived) {
    // Without the fence there is no window, and every assertion below would pass against a
    // realtime service that delivers nothing at all. That is the failure mode this script exists
    // to avoid, so it stops rather than reporting a leak check it cannot honestly make.
    bad("no window to judge the leak in, because nothing was delivered")
    mineFeed.stop()
    anonFeed.stop()
    process.exit(1)
  }

  console.log("")
  console.log("-- what the window shows")

  const leaked = mineFeed.rows.filter((r) => markOf(r) === STRANGER_MARK)
  check(
    leaked.length === 0,
    "and never receives the stranger's, which was written first",
    `received ${leaked.length} row(s) belonging to another user`,
  )

  const foreign = mineFeed.rows.filter((r) => r["subscriber_id"] !== mine.id)
  check(
    foreign.length === 0,
    "every row delivered belongs to the subscriber",
    `${foreign.length} of ${mineFeed.rows.length} did not`,
  )

  if (anonSubscribed) {
    check(
      anonFeed.rows.length === 0,
      "a subscriber with no session receives nothing",
      `received ${anonFeed.rows.length}`,
    )
  } else {
    ok("a subscriber with no session is refused the channel outright")
  }

  console.log("")
  console.log("-- and what it carried")

  // Separate from the questions above on purpose. The REST path preserves this through
  // `parseRowsExactly`. The realtime path parses the WAL with a plain `JSON.parse` in the service
  // and the frame with another in the client, so an exact column is rounded before an application
  // ever sees it.
  const delivered = mineFeed.rows.find(isFence)
  const gotExternalId = String(delivered?.["externalId"])
  check(
    gotExternalId === FENCE_EXTERNAL_ID,
    "a bigint past 2^53 arrives exactly, rather than rounded",
    `sent ${FENCE_EXTERNAL_ID}, received ${gotExternalId}`,
  )

  mineFeed.stop()
  anonFeed.stop()

  console.log("")
  if (failures > 0) {
    console.error(`FAILED: ${failures} assertion(s)`)
    process.exit(1)
  }
  console.log("PASSED: realtime delivers a subscriber their own rows and withholds everyone else's")
  process.exit(0)
}

void main().catch((err: unknown) => {
  console.error("THREW:", err instanceof Error ? err.message : String(err))
  process.exit(1)
})
