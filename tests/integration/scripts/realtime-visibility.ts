/**
 * Which changes reach a subscriber who may not see the row (H3: M06, P03) and whether a numeric
 * column filter compares numbers (F65: T1-N3), against a running stack.
 *
 * The project's schema is `realtime-visibility.schema.ts`. Each check writes a stranger's change
 * first and the subscriber's own change after it as a fence: when the fence arrives, the stranger's
 * change has had strictly longer to arrive and did not.
 *
 * A DELETE is judged on the whole old row, which the WAL carries only under REPLICA IDENTITY FULL.
 * Set `RT_EXPECT_DELETES=1` once the tables have it, to also assert the subscriber's own DELETE
 * is delivered. Without it, only "a stranger's DELETE is not delivered" is asserted.
 *
 * Env: SUPATYPE_KONG_PORT (or SUPATYPE_URL), ANON_KEY, SERVICE_ROLE_KEY.
 * Run: npx tsx scripts/realtime-visibility.ts (from tests/integration).
 */
import { createClient } from "@supatype/client"

const BASE = process.env["SUPATYPE_URL"] ?? `http://127.0.0.1:${process.env["SUPATYPE_KONG_PORT"] ?? "18473"}`
const ANON = process.env["ANON_KEY"] ?? ""
const SERVICE = process.env["SERVICE_ROLE_KEY"] ?? ""
const EXPECT_DELETES = process.env["RT_EXPECT_DELETES"] === "1"
if (!ANON || !SERVICE) throw new Error("ANON_KEY and SERVICE_ROLE_KEY must be set")

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Row = Record<string, unknown>
type Event = { eventType: string; new: Row | null; old: Row | null }
type Client = ReturnType<typeof createClient>

let failures = 0
function check(cond: boolean, message: string, detail = ""): void {
  if (cond) console.log(`  ok   ${message}`)
  else {
    failures++
    console.error(`  FAIL ${message}${detail ? ` - ${detail}` : ""}`)
  }
}

async function asService(method: string, path: string, body?: unknown): Promise<Row[]> {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  if (res.status >= 300) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`)
  return text ? (JSON.parse(text) as Row[]) : []
}

async function insertOne(table: string, row: Row): Promise<Row> {
  const [created] = await asService("POST", table, row)
  if (!created) throw new Error(`insert into ${table} returned no row`)
  return created
}

async function user(label: string): Promise<{ client: Client; id: string }> {
  const client = createClient({ url: BASE, anonKey: ANON })
  const { data, error } = await client.auth.signUp({
    email: `rtv-${label}-${RUN}@example.test`,
    password: "Correct-Horse-9",
  })
  const id = data?.user?.id
  if (error || typeof id !== "string") throw new Error(`signup ${label}: ${error?.message ?? "no id"}`)
  await insertOne("member", { id, name: label })
  return { client, id }
}

/** Every event this client is sent on a table, from the moment it is SUBSCRIBED. */
async function feed(client: Client, table: string, filter?: string): Promise<Event[]> {
  const events: Event[] = []
  const sub = client.from(table).subscribe((p) => events.push(p as unknown as Event), {
    event: "*",
    ...(filter !== undefined && { filter }),
  })
  const ready = await new Promise<boolean>((resolve) => {
    const deadline = setTimeout(() => resolve(false), 20_000)
    sub.channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(deadline)
        resolve(true)
      }
    })
  })
  if (!ready) throw new Error(`subscription to ${table} never reached SUBSCRIBED`)
  await sleep(1000)
  return events
}

async function arrives(events: Event[], pred: (e: Event) => boolean, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (events.some(pred)) return true
    await sleep(200)
  }
  return false
}

const keyOf = (e: Event, column: string): unknown => (e.new ?? e.old ?? {})[column]

type User = Awaited<ReturnType<typeof user>>

/** M06 A and P03: a stranger's DELETE must not reach the subscriber. */
async function deleteOfInvisibleRow(mine: User, theirs: User): Promise<void> {
  console.log("-- M06 A: DELETE of a row the subscriber cannot see (rt_item)")
  const stranger = await insertOne("rt_item", { owner_id: theirs.id, label: `stranger-${RUN}` })
  const own = await insertOne("rt_item", { owner_id: mine.id, label: `own-${RUN}` })
  const events = await feed(mine.client, "rt_item")
  await asService("DELETE", `rt_item?id=eq.${String(stranger["id"])}`)
  await sleep(300)
  if (EXPECT_DELETES) await asService("DELETE", `rt_item?id=eq.${String(own["id"])}`)
  const fence = await insertOne("rt_item", { owner_id: mine.id, label: `fence-${RUN}` })
  check(await arrives(events, (e) => keyOf(e, "id") === fence["id"]), "the subscriber's own INSERT (fence) arrives")
  check(
    !events.some((e) => keyOf(e, "id") === stranger["id"]),
    "a stranger's DELETE is not delivered",
    JSON.stringify(events.filter((e) => keyOf(e, "id") === stranger["id"])),
  )
  if (EXPECT_DELETES) {
    check(
      events.some((e) => e.eventType === "DELETE" && e.old?.["id"] === own["id"]),
      "the subscriber's own DELETE is delivered",
    )
  }
}

/** M06 B: a table keyed by `code`, whose first column the subscriber's own row shares. */
async function keyNotNamedId(mine: User, theirs: User): Promise<void> {
  console.log("-- M06 B: primary key not named id (rt_ticket)")
  const events = await feed(mine.client, "rt_ticket")
  const shared = `shared-${RUN}`
  const own = await insertOne("rt_ticket", { category: shared, owner_id: mine.id, label: "own" })
  await arrives(events, (e) => keyOf(e, "code") === own["code"], 15_000)
  const stranger = await insertOne("rt_ticket", { category: shared, owner_id: theirs.id, label: "stranger" })
  await asService("PATCH", `rt_ticket?code=eq.${String(stranger["code"])}`, { label: "stranger-updated" })
  await sleep(300)
  const fence = await insertOne("rt_ticket", { category: `fence-${RUN}`, owner_id: mine.id, label: "fence" })
  check(await arrives(events, (e) => keyOf(e, "code") === fence["code"]), "the subscriber's own INSERT (fence) arrives")
  check(events.some((e) => keyOf(e, "code") === own["code"]), "the subscriber's own row in the shared category arrives")
  check(
    !events.some((e) => keyOf(e, "code") === stranger["code"]),
    "a stranger's INSERT and UPDATE in the same category are not delivered",
    JSON.stringify(events.filter((e) => keyOf(e, "code") === stranger["code"])),
  )
}

/** P03: B subscribes to `note` and must hear nothing about A's note. */
async function ownerOnlyNote(a: User, b: User): Promise<void> {
  console.log("-- P03: owner-only note, insert, update and delete of someone else's")
  const events = await feed(b.client, "note")
  await insertOne("note", { id: a.id, body: `secret-of-A-${RUN}` })
  await asService("PATCH", `note?id=eq.${a.id}`, { body: `secret-of-A-updated-${RUN}` })
  await asService("DELETE", `note?id=eq.${a.id}`)
  await sleep(300)
  await insertOne("note", { id: b.id, body: `fence-${RUN}` })
  check(await arrives(events, (e) => keyOf(e, "id") === b.id), "B's own note (fence) arrives")
  check(
    !events.some((e) => JSON.stringify(e).includes(a.id)),
    "nothing about A's note reaches B, the DELETE included",
    JSON.stringify(events.filter((e) => JSON.stringify(e).includes(a.id))),
  )
}

/** T1-N3: `points=gt.100000` must not deliver 95000, which sorts after "100000" as text. */
async function numericFilter(mine: User): Promise<void> {
  console.log("-- T1-N3: a numeric filter compares numbers")
  const events = await feed(mine.client, "rt_score", "points=gt.100000")
  const low = await insertOne("rt_score", { owner_id: mine.id, points: 95000 })
  await sleep(300)
  const fence = await insertOne("rt_score", { owner_id: mine.id, points: 120000 })
  check(await arrives(events, (e) => keyOf(e, "id") === fence["id"]), "120000 (fence) arrives")
  check(
    !events.some((e) => keyOf(e, "id") === low["id"]),
    "95000 is not delivered to points=gt.100000",
    JSON.stringify(events.filter((e) => keyOf(e, "id") === low["id"])),
  )
}

async function main(): Promise<void> {
  const mine = await user("mine")
  const theirs = await user("theirs")
  console.log(`deletes asserted for the subscriber's own rows: ${EXPECT_DELETES}`)
  await deleteOfInvisibleRow(mine, theirs)
  await keyNotNamedId(mine, theirs)
  await ownerOnlyNote(theirs, mine)
  await numericFilter(mine)
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error("THREW", err instanceof Error ? err.message : err)
  process.exit(2)
})
