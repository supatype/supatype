/**
 * `useQuery` shows the answer to the latest request. When the options change while a read is in
 * flight, the older read can finish last; whatever it brings, rows, a returned error or a throw,
 * must not replace what the newer one showed.
 */

import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { createClient, QueryBuilder, SupatypeError, type AnyDatabase, type QueryResult } from "@supatype/client"
import { SupatypeProvider } from "../src/context.js"
import { useQuery } from "../src/useQuery.js"

interface PendingRead {
  resolve(result: QueryResult<unknown[]>): void
  reject(reason: unknown): void
}

/** Every read waits until the test settles it, in the order the hook sent them. */
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

function Posts({ id }: { id: number }): React.ReactElement {
  const { data, error, loading } = useQuery<AnyDatabase>("posts", { filter: { id } })
  if (loading) return <p>loading</p>
  if (error !== null) return <p>error: {error.message}</p>
  return <p>rows: {JSON.stringify(data)}</p>
}

const client = createClient<AnyDatabase>({ url: "http://localhost:9999", anonKey: "anon" })

/** Renders for id 1, then id 2, leaving both reads held. */
async function twoReadsInFlight(): Promise<{ tree: ReactTestRenderer; older: PendingRead; newer: PendingRead }> {
  const reads = heldReads()
  let tree: ReactTestRenderer | null = null
  await act(async () => {
    tree = create(<SupatypeProvider client={client}><Posts id={1} /></SupatypeProvider>)
  })
  if (tree === null) throw new Error("nothing rendered")
  const rendered: ReactTestRenderer = tree
  const older = reads.at(-1)
  await act(async () => {
    rendered.update(<SupatypeProvider client={client}><Posts id={2} /></SupatypeProvider>)
  })
  const newer = reads.at(-1)
  if (older === undefined || newer === undefined || older === newer) throw new Error("expected two reads")
  return { tree: rendered, older, newer }
}

function textOf(tree: ReactTestRenderer): string {
  return tree.root.findByType("p").children.join("")
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useQuery when an older read finishes last", () => {
  it("keeps the newer rows over the older rows", async () => {
    const { tree, older, newer } = await twoReadsInFlight()
    await act(async () => newer.resolve(rows(2)))
    await act(async () => older.resolve(rows(1)))
    expect(textOf(tree)).toBe('rows: [{"id":2}]')
  })

  it("keeps the newer rows over the older read's returned error", async () => {
    const { tree, older, newer } = await twoReadsInFlight()
    await act(async () => newer.resolve(rows(2)))
    await act(async () => older.resolve({ data: null, error: new SupatypeError({ message: "permission denied" }), count: null }))
    expect(textOf(tree)).toBe('rows: [{"id":2}]')
  })

  it("keeps the newer rows over the older read's throw, still reporting it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const thrown = new Error("Supatype client has no API address")
    const { tree, older, newer } = await twoReadsInFlight()
    await act(async () => newer.resolve(rows(2)))
    await act(async () => older.reject(thrown))
    expect(textOf(tree)).toBe('rows: [{"id":2}]')
    expect(logged.mock.calls.filter((call) => call.includes(thrown))).toHaveLength(1)
  })

  it("stays loading while the newer read is in flight after the older one lands", async () => {
    const { tree, older } = await twoReadsInFlight()
    await act(async () => older.resolve(rows(1)))
    expect(textOf(tree)).toBe("loading")
  })
})
