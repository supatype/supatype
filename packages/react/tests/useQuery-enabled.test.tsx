/**
 * 0.9.2 release test (N-FF9): `useQuery` reported `loading: false, data: null` on the render where
 * `enabled` turned true, before its effect started the read. An app reads that pair as "done,
 * nothing found": expo-auth wrote the email's local part as the display name and never looked
 * again. No render may show that pair for a key whose answer has not arrived.
 */

import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { createClient, QueryBuilder, type AnyDatabase, type QueryResult } from "@supatype/client"
import { SupatypeProvider } from "../src/context.js"
import { useQuery } from "../src/useQuery.js"

interface Frame {
  loading: boolean
  data: unknown[] | null
}

const client = createClient<AnyDatabase>({ url: "http://localhost:9999", anonKey: "anon" })

/** Every read waits until the test settles it. */
function heldReads(): Array<(result: QueryResult<unknown[]>) => void> {
  const reads: Array<(result: QueryResult<unknown[]>) => void> = []
  vi.spyOn(QueryBuilder.prototype, "then").mockImplementation((onOk, onRejected) =>
    new Promise<QueryResult<unknown[]>>((resolve) => reads.push(resolve)).then(onOk, onRejected),
  )
  return reads
}

function Profile({ userId, frames }: { userId: string | null; frames: Frame[] }): React.ReactElement {
  const { loading, data } = useQuery<AnyDatabase>("profiles", {
    filter: { id: userId },
    enabled: userId !== null,
  })
  frames.push({ loading, data })
  return <p>{loading ? "loading" : JSON.stringify(data)}</p>
}

async function render(frames: Frame[], userId: string | null): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | null = null
  await act(async () => {
    tree = create(<SupatypeProvider client={client}><Profile userId={userId} frames={frames} /></SupatypeProvider>)
  })
  if (tree === null) throw new Error("nothing rendered")
  return tree
}

/** True for a frame an app would take as "the read finished and found nothing". */
const looksDoneAndEmpty = (frame: Frame): boolean => !frame.loading && frame.data === null

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useQuery when enabled turns true", () => {
  it("is loading from the first render it is enabled until the rows arrive", async () => {
    const reads = heldReads()
    const frames: Frame[] = []
    const tree = await render(frames, null)
    expect(frames.at(-1)).toEqual({ loading: false, data: null })

    const enabledFrom = frames.length
    await act(async () => {
      tree.update(<SupatypeProvider client={client}><Profile userId="u1" frames={frames} /></SupatypeProvider>)
    })
    expect(frames.slice(enabledFrom).filter(looksDoneAndEmpty)).toEqual([])

    const settle = reads.at(-1)
    if (settle === undefined) throw new Error("expected a read once enabled")
    await act(async () => settle({ data: [{ id: "u1", display_name: "Nic" }], error: null, count: null }))
    expect(frames.at(-1)).toEqual({ loading: false, data: [{ id: "u1", display_name: "Nic" }] })
  })

  it("is not loading while disabled, from the first render", async () => {
    heldReads()
    const frames: Frame[] = []
    await render(frames, null)
    expect(frames.filter((frame) => frame.loading)).toEqual([])
  })

  it("is loading from the first render when the options change to a key with no answer", async () => {
    const reads = heldReads()
    const frames: Frame[] = []
    const tree = await render(frames, "u1")
    await act(async () => reads.at(-1)?.({ data: [{ id: "u1" }], error: null, count: null }))

    const changedFrom = frames.length
    await act(async () => {
      tree.update(<SupatypeProvider client={client}><Profile userId="u2" frames={frames} /></SupatypeProvider>)
    })
    expect(frames[changedFrom]?.loading).toBe(true)
  })
})
