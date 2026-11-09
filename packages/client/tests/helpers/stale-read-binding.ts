import { vi, describe, it, expect, afterEach } from "vitest"
import { createClient, QueryBuilder, SupatypeError, type AnyDatabase, type QueryResult, type SupatypeClient } from "@supatype/client"

/**
 * What every framework binding's query owes a read that finishes after a newer one: nothing.
 *
 * A refetch while a read is in flight puts two reads on the wire, and the older can land last.
 * Whatever it brings, rows, a returned error or a throw, must not replace what the newer read
 * showed, nor end loading while the newer read is still out. Shared by the Vue, Svelte and Solid
 * suites over a real client, built from the package the bindings import, so the prototype held
 * is the one the bindings call. Not named `*.test.ts`, so vitest's default include does not
 * collect it as a suite.
 */
export interface StaleReadProbe {
  data(): unknown
  error(): unknown
  loading(): boolean
  refetch(): Promise<void>
}

interface PendingRead {
  resolve(result: QueryResult<unknown[]>): void
  reject(reason: unknown): void
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Every read waits until the test settles it, in the order the binding sent them. */
function heldReads(): PendingRead[] {
  const reads: PendingRead[] = []
  vi.spyOn(QueryBuilder.prototype, "then").mockImplementation((onOk, onRejected) => {
    const answer = new Promise<QueryResult<unknown[]>>((resolve, reject) => reads.push({ resolve, reject }))
    return answer.then(onOk, onRejected)
  })
  return reads
}

function rows(id: number): QueryResult<unknown[]> {
  return { data: [{ id }], error: null, count: null }
}

interface InFlight {
  probe: StaleReadProbe
  older: PendingRead
  newer: PendingRead
  newerDone: Promise<void>
}

export function describeStaleReadBinding(
  name: string,
  mount: (client: SupatypeClient<AnyDatabase>) => StaleReadProbe,
  unmount: () => void,
): void {
  /** The binding's first read and a refetch, both still out. */
  async function twoReadsInFlight(): Promise<InFlight> {
    const reads = heldReads()
    const probe = mount(createClient<AnyDatabase>({ url: "http://localhost:9999", anonKey: "anon" }))
    await settle()
    const older = reads.at(-1)
    const newerDone = probe.refetch()
    await settle()
    const newer = reads.at(-1)
    if (older === undefined || newer === undefined || older === newer) throw new Error("expected two reads")
    return { probe, older, newer, newerDone }
  }

  describe(`${name} when an older read finishes last`, () => {
    afterEach(() => {
      unmount()
      vi.restoreAllMocks()
    })

    it("keeps the newer rows over the older rows", async () => {
      const { probe, older, newer, newerDone } = await twoReadsInFlight()
      newer.resolve(rows(2))
      await newerDone
      older.resolve(rows(1))
      await settle()
      expect(probe.data()).toEqual([{ id: 2 }])
    })

    it("keeps the newer rows over the older read's returned error", async () => {
      const { probe, older, newer, newerDone } = await twoReadsInFlight()
      newer.resolve(rows(2))
      await newerDone
      older.resolve({ data: null, error: new SupatypeError({ message: "permission denied" }), count: null })
      await settle()
      expect(probe.data()).toEqual([{ id: 2 }])
      expect(probe.error()).toBeNull()
    })

    it("keeps the newer rows over the older read's throw, still reporting it", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
      const thrown = new Error("Supatype client has no API address")
      const { probe, older, newer, newerDone } = await twoReadsInFlight()
      newer.resolve(rows(2))
      await newerDone
      older.reject(thrown)
      await settle()
      expect(probe.data()).toEqual([{ id: 2 }])
      expect(probe.error()).toBeNull()
      expect(logged.mock.calls.filter((call) => call.includes(thrown))).toHaveLength(1)
    })

    it("stays loading while the newer read is out after the older one lands", async () => {
      const { probe, older } = await twoReadsInFlight()
      older.resolve(rows(1))
      await settle()
      expect(probe.loading()).toBe(true)
      expect(probe.data()).toBeNull()
    })
  })
}
