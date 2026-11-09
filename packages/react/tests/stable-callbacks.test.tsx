/**
 * The functions a hook returns keep their identity across renders, as React's own hooks do, so an
 * app can list them as effect dependencies.
 *
 * 0.9.1 release test (RB10): `useQuery` built a new `refetch` on every render, and the expo-auth
 * example's `useEffect(() => { void refetch() }, [refetch])` looped, sending thousands of requests
 * a second until React stopped it with "Maximum update depth exceeded".
 */

import React, { useEffect } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { createClient, QueryBuilder, type AnyDatabase, type QueryResult } from "@supatype/client"
import { SupatypeProvider } from "../src/context.js"
import { useQuery, type UseQueryResult } from "../src/useQuery.js"
import { useAuth, type UseAuthReturn } from "../src/useAuth.js"

/** Every read answers at once with one row; returns how many were sent. */
function countedReads(): { count: () => number } {
  let reads = 0
  vi.spyOn(QueryBuilder.prototype, "then").mockImplementation((onOk, onRejected) => {
    reads += 1
    return Promise.resolve<QueryResult<unknown[]>>({ data: [{ id: reads }], error: null, count: null }).then(onOk, onRejected)
  })
  return { count: () => reads }
}

const client = createClient<AnyDatabase>({ url: "http://localhost:9999", anonKey: "anon" })

/** Every `refetch` the hook handed out, one per render. */
const refetches: Array<UseQueryResult<unknown>["refetch"]> = []

function Posts({ id, label }: { id: number; label: string }): React.ReactElement {
  const { data, refetch } = useQuery<AnyDatabase>("posts", { filter: { id } })
  refetches.push(refetch)
  return <p>{label}: {JSON.stringify(data)}</p>
}

/** Effect runs past this many stop refetching, so a loop ends instead of exhausting the heap. */
const EFFECT_CAP = 20

/** How many times `RefetchOnChange`'s effect has run. */
const effectRuns = { count: 0 }

/** The expo-auth pattern: refetch whenever `refetch` (or anything else listed) changes. */
function RefetchOnChange({ author }: { author: string }): React.ReactElement {
  const { data, refetch } = useQuery<AnyDatabase>("profiles", { filter: { author } })
  useEffect(() => {
    effectRuns.count += 1
    if (effectRuns.count <= EFFECT_CAP) refetch()
  }, [author, refetch])
  return <p>{JSON.stringify(data)}</p>
}

async function mount(element: React.ReactElement): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | null = null
  await act(async () => {
    tree = create(<SupatypeProvider client={client}>{element}</SupatypeProvider>)
  })
  if (tree === null) throw new Error("nothing rendered")
  return tree
}

afterEach(() => {
  vi.restoreAllMocks()
  refetches.length = 0
  effectRuns.count = 0
})

describe("useQuery's refetch", () => {
  it("is the same function on every render while the query is unchanged", async () => {
    countedReads()
    const tree = await mount(<Posts id={1} label="first" />)
    await act(async () => {
      tree.update(<SupatypeProvider client={client}><Posts id={1} label="second" /></SupatypeProvider>)
    })
    expect(refetches.length).toBeGreaterThan(1)
    expect(new Set(refetches).size).toBe(1)
  })

  it("is a new function once the query it runs changes", async () => {
    countedReads()
    const tree = await mount(<Posts id={1} label="posts" />)
    const before = refetches.at(-1)
    await act(async () => {
      tree.update(<SupatypeProvider client={client}><Posts id={2} label="posts" /></SupatypeProvider>)
    })
    expect(refetches.at(-1)).not.toBe(before)
  })

  it("can be an effect dependency without the effect looping", async () => {
    const reads = countedReads()
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await mount(<RefetchOnChange author="ada" />)
    expect(effectRuns.count).toBe(1)
    // One read from the hook on mount and one from the app's effect.
    expect(reads.count()).toBe(2)
    expect(errors).not.toHaveBeenCalled()
  })
})

describe("useAuth's methods", () => {
  it("are the same functions on every render", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })))
    const seen: UseAuthReturn[] = []
    function Probe({ label }: { label: string }): React.ReactElement {
      const auth = useAuth()
      seen.push(auth)
      return <p>{label}</p>
    }
    const tree = await mount(<Probe label="first" />)
    await act(async () => {
      tree.update(<SupatypeProvider client={client}><Probe label="second" /></SupatypeProvider>)
    })
    vi.unstubAllGlobals()
    const first = seen[0]
    const last = seen.at(-1)
    if (first === undefined || last === undefined || first === last) throw new Error("expected two renders")
    for (const name of ["signUp", "signIn", "signInWithOAuth", "signInWithSSO", "signInWithOtp", "signOut"] as const) {
      expect(last[name], name).toBe(first[name])
    }
  })
})
