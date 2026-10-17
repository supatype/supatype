import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { RealtimeServer } from "../src/server.js"
import { RlsFilter, type DeliveryVerdict } from "../src/rls.js"
import { Tap, TapSession, type StreamSink, type TapItem } from "../src/admin/tap.js"
import type { JwtClaims } from "../src/auth.js"
import type { WalChange } from "../src/types.js"
import { isNumber, isShape } from "../src/json.js"
import { expectJson } from "./fixtures/expect-json.js"
import { connect, freePort, subscribe, testEnv, userToken, type Peer } from "./fixtures/socket.js"

/**
 * The message tap: off unless an inspector is open, bounded when one is, and never on the delivery
 * path. Delivery must not wait for, or slow down for, anybody watching it.
 */

/** Every subscriber sees every change, unmasked: the tap's cost is the question, not the rules. */
class PassThroughFilter extends RlsFilter {
  constructor() {
    super("postgresql://nobody:nothing@127.0.0.1:1/none")
  }
  override async maskedColumns(): Promise<Set<string>> {
    return new Set()
  }
  override async judgeForDelivery(_claims: JwtClaims | null, change: WalChange): Promise<DeliveryVerdict> {
    return { send: change, redacted: { old: [], new: [] } }
  }
}

function change(i: number, over: Partial<WalChange> = {}): WalChange {
  return {
    schema: "public",
    table: "posts",
    event: "INSERT",
    newRecord: { id: i, title: `post ${i}` },
    oldRecord: null,
    exactColumns: {},
    columnTypes: {},
    commitTimestamp: new Date().toISOString(),
    ...over,
  }
}

/** A sink that keeps what it is sent, or, stalled, accepts the first write and then never drains. */
function sink(stalled = false): StreamSink & { chunks: string[] } {
  const chunks: string[] = []
  return {
    chunks,
    write(chunk: string): boolean {
      chunks.push(chunk)
      return !stalled
    },
    onDrain(): void {},
  }
}

/** Renders the item's kind and sequence, so a test can count what reached the sink. */
const echo = async (item: TapItem): Promise<{ event: string; data: unknown }> => ({
  event: item.kind,
  data: { seq: item.seq },
})

const events = (chunks: string[], name: string): string[] =>
  chunks.filter((chunk) => chunk.startsWith(`event: ${name}\n`))

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("a session's sampling and filters", () => {
  const sessions: TapSession[] = []
  afterEach(() => {
    for (const s of sessions.splice(0)) s.close()
  })

  function open(tap: Tap, opts: { rate: number; filters?: Partial<ConstructorParameters<typeof TapSession>[0]["filters"]>; out: StreamSink }): TapSession {
    const session = new TapSession({
      actor: "tester",
      rate: opts.rate,
      filters: { kinds: new Set(["change", "broadcast", "presence"]), ...opts.filters },
      sink: opts.out,
      render: echo,
    })
    tap.add(session)
    sessions.push(session)
    return session
  }

  it("keeps to its rate, and says how many it skipped", async () => {
    const tap = new Tap()
    const out = sink()
    open(tap, { rate: 10, out })

    for (let i = 0; i < 50; i++) {
      const record = tap.begin(change(i), ["posts"])
      if (record) tap.end(record)
    }

    await until(() => events(out.chunks, "sampled").length > 0, 2500)
    expect(events(out.chunks, "change").length).toBeLessThanOrEqual(10)
    const sampled = expectJson(JSON.parse(events(out.chunks, "sampled")[0]!.split("data: ")[1]!), isShape({ skipped: isNumber }))
    expect(sampled.skipped).toBeGreaterThanOrEqual(40)
  })

  it("selects only the table and event it asked for", async () => {
    const tap = new Tap()
    const out = sink()
    open(tap, { rate: 100, filters: { table: "posts", event: "UPDATE" }, out })

    const fed = [
      change(1),
      change(2, { event: "UPDATE", oldRecord: { id: 2 } }),
      change(3, { table: "comments", event: "UPDATE" }),
    ]
    let wanted = 0
    for (const c of fed) {
      const record = tap.begin(c, ["any"])
      if (record) {
        wanted++
        tap.end(record)
      }
    }

    expect(wanted).toBe(1)
    await until(() => events(out.chunks, "change").length === 1)
  })

  it("does no work at all for a change nobody wants", () => {
    const tap = new Tap()
    open(tap, { rate: 100, filters: { table: "other" }, out: sink() })
    expect(tap.begin(change(1), ["posts"])).toBeNull()
  })
})

describe("the tap on the delivery path", () => {
  let server: RealtimeServer
  let tap: Tap
  let port: number
  let subscriber: Peer

  beforeAll(async () => {
    port = await freePort()
    tap = new Tap()
    server = new RealtimeServer(testEnv(port), { rlsFilter: new PassThroughFilter(), tap })
    await server.start()
    subscriber = await connect(port, userToken("watcher"))
    await subscribe(subscriber, "posts", { table: "posts" })
  })

  afterAll(async () => {
    subscriber.close()
    await server.stop()
  })

  it("is never asked about a change while nobody is watching", async () => {
    const begin = vi.spyOn(tap, "begin")
    const before = subscriber.frames.length
    await server.dispatchChange(change(1))
    await until(() => subscriber.frames.length === before + 1)
    expect(tap.active).toBe(false)
    expect(begin).not.toHaveBeenCalled()
    begin.mockRestore()
  })

  it("delivers everything while a stalled inspector's queue stays bounded", async () => {
    const out = sink(true)
    const session = new TapSession({
      actor: "stalled",
      // Far above what the stream route allows, so the queue cap is what is tested, not the rate.
      rate: 1_000_000,
      filters: { kinds: new Set(["change"]) },
      sink: out,
      render: echo,
    })
    tap.add(session)
    try {
      const before = subscriber.frames.length
      await Promise.all(Array.from({ length: 1000 }, (_, i) => server.dispatchChange(change(i))))
      await until(() => subscriber.frames.length === before + 1000, 10_000)

      expect(session.queued).toBeLessThanOrEqual(500)
      expect(session.queued).toBeGreaterThan(0)
      expect(session.dropped).toBeGreaterThanOrEqual(500)
    } finally {
      session.close()
    }
  })

  it("logs what an open inspector costs (not a gate)", async () => {
    const time = async (): Promise<number> => {
      const before = subscriber.frames.length
      const started = performance.now()
      for (let i = 0; i < 500; i++) await server.dispatchChange(change(i))
      await until(() => subscriber.frames.length === before + 500, 10_000)
      return (performance.now() - started) / 500
    }
    const closed = await time()
    const session = new TapSession({
      actor: "bench",
      rate: 100,
      filters: { kinds: new Set(["change"]) },
      sink: sink(),
      render: echo,
    })
    tap.add(session)
    const open = await time()
    session.close()
    console.log(`[tap bench] mean dispatch per change: closed ${closed.toFixed(3)} ms, open ${open.toFixed(3)} ms`)
    expect(open).toBeGreaterThan(0)
  })
})
