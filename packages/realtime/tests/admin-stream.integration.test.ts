import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"
import jwt from "jsonwebtoken"
import { RealtimeServer } from "../src/server.js"
import { PREAMBLE } from "./fixtures/owned-table.js"
import { nextText } from "./fixtures/stream.js"
import { expectJson, expectObject } from "./fixtures/expect-json.js"
import { isArrayOf, isBoolean, isJsonObject, isShape, isString, nullable, optional } from "../src/json.js"
import {
  SECRET,
  connect,
  freePort,
  serviceToken,
  subscribe,
  testEnv,
  userToken,
  type Peer,
} from "./fixtures/socket.js"

/**
 * The inspector's live stream against a real database: what each payload view may show.
 *
 * The rule under test: the inspector never shows a viewer more than the subscriber received, never
 * more than the viewer could already read, and never the raw WAL row. The salary below is a value
 * only its owner may read; it may appear in exactly one place, the `delivered` view's delivery to
 * that owner, because that is what the owner was sent.
 *
 * Needs `DATABASE_URL` pointing at a database with `supatype_mask` and wal2json. Skips otherwise.
 */
const databaseUrl = process.env["DATABASE_URL"]

const SALARY = 987654321
const SLOT = `rt_stream_test_${process.pid}`

const SETUP = `
  ${PREAMBLE}
  DROP TABLE IF EXISTS rt_stream CASCADE;
  CREATE TABLE rt_stream (id int PRIMARY KEY, title text, salary numeric, author_id text, visible_to text);
  ALTER TABLE rt_stream REPLICA IDENTITY FULL;
  ALTER TABLE rt_stream ENABLE ROW LEVEL SECURITY;
  CREATE POLICY rt_stream_read ON rt_stream FOR SELECT TO authenticated USING (
    author_id = current_setting('request.jwt.claims', true)::jsonb->>'sub'
    OR visible_to = current_setting('request.jwt.claims', true)::jsonb->>'sub'
  );
  GRANT SELECT ON rt_stream TO authenticated;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      CREATE ROLE service_role;
    END IF;
  END $$;
  GRANT ALL ON rt_stream TO service_role;
  CREATE OR REPLACE FUNCTION can_read_rt_stream__salary(rt_stream rt_stream)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT author_id = current_setting('request.jwt.claims', true)::jsonb->>'sub'
        FROM (SELECT ($1).*) AS rt_stream;
    $$;
  SECURITY LABEL FOR supatype ON COLUMN rt_stream.salary IS 'MASK READ public."can_read_rt_stream__salary"';
`

interface SseEvent {
  event: string
  data: Record<string, unknown>
}

/** An open stream: its raw bytes so far, and its events parsed. */
interface Stream {
  raw(): string
  events(name: string): SseEvent[]
  close(): void
}

async function openStream(
  adminPort: number,
  query: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; stream: Stream | null; body: string }> {
  const controller = new AbortController()
  const res = await fetch(`http://127.0.0.1:${adminPort}/admin/v1/stream?${query}`, {
    headers: { Authorization: `Bearer ${serviceToken()}`, ...headers },
    signal: controller.signal,
  })
  if (res.status !== 200 || res.body === null) {
    return { status: res.status, stream: null, body: await res.text() }
  }
  let raw = ""
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const text = await nextText(reader, decoder)
        if (text === null) break
        raw += text
      }
    } catch {
      // Aborted by close().
    }
  })()
  const stream: Stream = {
    raw: () => raw,
    events: (name) =>
      raw
        .split("\n\n")
        .filter((block) => block.startsWith(`event: ${name}\n`))
        .map((block) => ({ event: name, data: expectObject(JSON.parse(block.split("\ndata: ")[1]!)) })),
    close: () => controller.abort(),
  }
  return { status: 200, stream, body: "" }
}

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const viewerHeader = (sub: string): Record<string, string> => ({
  "X-Supatype-Viewer-Authorization": `Bearer ${userToken(sub)}`,
  "X-Supatype-Studio-Actor": `viewer-${sub}`,
})

/** One delivery in a change event, as far as these tests read it. */
const isDeliveries = isArrayOf(
  isShape({
    connectionId: isString,
    payload: optional(isShape({ new: nullable(isJsonObject) })),
    redacted: optional(isShape({ new: isArrayOf(isString) })),
  }),
)

const isViewerVerdict = isShape({
  visible: isBoolean,
  payload: isShape({ new: isJsonObject }),
  redacted: isShape({ new: isArrayOf(isString) }),
})

describe.skipIf(!databaseUrl)("GET /admin/v1/stream payload views", () => {
  let admin: pg.Client
  let server: RealtimeServer
  let port: number
  let adminPort: number
  const peers: Peer[] = []
  const streams: Stream[] = []

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    await admin.query(SETUP)
    port = await freePort()
    adminPort = await freePort()
    server = new RealtimeServer(testEnv(port, { adminPort, databaseUrl: databaseUrl!, slotName: SLOT, replicationPollInterval: 100 }))
    await server.start()
    await server.waitForReplicationStartup()
  })

  afterAll(async () => {
    for (const s of streams) s.close()
    for (const p of peers) p.close()
    await server?.stop()
    await admin?.query(`SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = $1`, [SLOT]).catch(() => {})
    await admin?.query("DROP TABLE IF EXISTS rt_stream CASCADE")
    await admin?.end()
  })

  const open = async (query: string, headers: Record<string, string> = {}): Promise<Stream> => {
    const { status, stream } = await openStream(adminPort, query, headers)
    expect(status).toBe(200)
    streams.push(stream!)
    await until(() => stream!.events("ready").length === 1)
    return stream!
  }

  it("shows each view what it may see, and never the raw row", { timeout: 20_000 }, async () => {
    const alice = await connect(port, userToken("alice"))
    const bob = await connect(port, userToken("bob"))
    peers.push(alice, bob)
    await subscribe(alice, "stream:alice", { schema: "public", table: "rt_stream" })
    await subscribe(bob, "stream:bob", { schema: "public", table: "rt_stream" })

    const delivered = await open("view=delivered", { "X-Supatype-Studio-Actor": "admin-1" })
    const redacted = await open("view=redacted", { "X-Supatype-Studio-Actor": "dev-cloud" })
    const asBob = await open("view=viewer", viewerHeader("bob"))
    const asCarol = await open("view=viewer", viewerHeader("carol"))
    const none = await open("view=none", { "X-Supatype-Studio-Actor": "meta" })

    // As service_role: supatype_mask applies a column's read rule to what a non-exempt session writes
    // into it, so the same INSERT as plain postgres stores NULL rather than the value.
    await admin.query("BEGIN")
    await admin.query("SET LOCAL ROLE service_role")
    await admin.query(`INSERT INTO rt_stream VALUES (1, 'hello', ${SALARY}, 'alice', 'bob')`)
    await admin.query("COMMIT")
    await alice.next((m) => m.type === "change", 5000)
    await bob.next((m) => m.type === "change", 5000)
    for (const s of [delivered, redacted, asBob, asCarol, none]) {
      await until(() => s.events("change").length === 1, 5000)
    }

    const deliveries = expectJson(delivered.events("change")[0]!.data["deliveries"], isDeliveries)
    expect(deliveries).toHaveLength(2)
    const toBob = deliveries.find((d) => d.payload?.new?.["salary"] === null)!
    const toAlice = deliveries.find((d) => d !== toBob)!
    expect(toBob.redacted?.new).toContain("salary")
    expect(JSON.stringify(toBob)).not.toContain(String(SALARY))
    expect(JSON.stringify(toAlice)).toContain(String(SALARY))

    for (const d of expectJson(redacted.events("change")[0]!.data["deliveries"], isDeliveries)) {
      expect(d.payload?.new?.["salary"]).toBeNull()
      expect(d.redacted?.new).toContain("salary")
    }

    const bobView = expectJson(asBob.events("change")[0]!.data["viewer"], isViewerVerdict)
    expect(bobView.visible).toBe(true)
    expect(bobView.payload.new["salary"]).toBeNull()
    expect(bobView.redacted.new).toContain("salary")
    for (const d of expectJson(asBob.events("change")[0]!.data["deliveries"], isDeliveries)) {
      expect(d).not.toHaveProperty("payload")
    }

    const carolView = expectObject(asCarol.events("change")[0]!.data["viewer"])
    expect(carolView).toEqual({ visible: false })

    expect(none.raw()).not.toContain('"payload"')
    for (const s of [redacted, asBob, asCarol, none]) {
      expect(s.raw()).not.toContain(String(SALARY))
    }
  })

  it("refuses a viewer stream without the viewer's token", async () => {
    const res = await openStream(adminPort, "view=viewer", { "X-Supatype-Studio-Actor": "nobody" })
    expect(res.status).toBe(400)
    const forged = await openStream(adminPort, "view=viewer", {
      "X-Supatype-Viewer-Authorization": `Bearer ${jwt.sign({ sub: "x", role: "authenticated" }, "not-the-secret")}`,
    })
    expect(forged.status).toBe(400)
    expect(SECRET).not.toBe("not-the-secret")
  })

  it("refuses an unknown view", async () => {
    expect((await openStream(adminPort, "view=raw")).status).toBe(400)
  })
})
