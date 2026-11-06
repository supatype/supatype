/**
 * A request that throws instead of answering `{ data, error }` ends the hook's loading and becomes
 * its `error`, reported once to the console.
 *
 * The client answers a refusal with `{ data, error }`, but some faults are thrown on purpose: a
 * client with no API address or anon key throws from its first request. A hook that only awaited
 * the request left the component on loading forever, with the rejection unhandled.
 */

import React from "react"
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { createClient, MutationBuilder, QueryBuilder, type AnyDatabase, type SupatypeClient } from "@supatype/client"
import { SupatypeProvider } from "../src/context.js"
import { useQuery } from "../src/useQuery.js"
import { useMutation, type UseMutationResult } from "../src/useMutation.js"
import { useFunction, type UseFunctionResult } from "../src/useFunction.js"
import { useAuth } from "../src/useAuth.js"

class SetupFault extends Error {
  constructor() {
    super("Supatype client has no API address")
    this.name = "SetupFault"
  }
}

function client(): SupatypeClient<AnyDatabase> {
  return createClient<AnyDatabase>({ url: "http://localhost:9999", anonKey: "anon" })
}

/** Every read through the client rejects with `thrown`, as a request that throws does. */
function readsThrow(thrown: unknown): void {
  vi.spyOn(QueryBuilder.prototype, "then").mockImplementation((_onOk, onRejected) =>
    Promise.reject(thrown).then(undefined, onRejected),
  )
}

/** Every write through the client rejects with `thrown`. */
function writesThrow(thrown: unknown): void {
  vi.spyOn(MutationBuilder.prototype, "then").mockImplementation((_onOk, onRejected) =>
    Promise.reject(thrown).then(undefined, onRejected),
  )
}

/** The console.error calls that carry `thrown`. */
function reportsOf(logged: MockInstance<typeof console.error>, thrown: unknown): number {
  return logged.mock.calls.filter((call) => call.includes(thrown)).length
}

function silenceConsole(): MockInstance<typeof console.error> {
  return vi.spyOn(console, "error").mockImplementation(() => undefined)
}

function Posts(): React.ReactElement {
  const { data, error, loading } = useQuery<AnyDatabase>("posts")
  if (loading) return <p>loading</p>
  if (error !== null) return <p>error: {error.message}</p>
  return <p>{data?.length ?? 0} rows</p>
}

async function render(element: React.ReactElement, using = client()): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | null = null
  await act(async () => {
    tree = create(<SupatypeProvider client={using}>{element}</SupatypeProvider>)
  })
  if (tree === null) throw new Error("nothing rendered")
  return tree
}

function textOf(tree: ReactTestRenderer): string {
  return tree.root.findByType("p").children.join("")
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("useQuery when the request throws", () => {
  it("stops loading, renders the thrown error and reports it once", async () => {
    const thrown = new SetupFault()
    readsThrow(thrown)
    const logged = silenceConsole()
    const tree = await render(<Posts />)
    expect(textOf(tree)).toBe("error: Supatype client has no API address")
    expect(reportsOf(logged, thrown)).toBe(1)
  })

  it("still shows a returned error without reporting it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ message: "permission denied", code: "42501" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    )))
    const logged = silenceConsole()
    const tree = await render(<Posts />)
    expect(textOf(tree)).toBe("error: permission denied")
    expect(logged).not.toHaveBeenCalled()
  })
})

describe("useMutation when the request throws", () => {
  it("answers and holds the thrown error, stops loading and reports it once", async () => {
    const thrown = new SetupFault()
    writesThrow(thrown)
    const logged = silenceConsole()
    const probe: { hook: UseMutationResult<unknown> | null } = { hook: null }
    function Probe(): null {
      probe.hook = useMutation<AnyDatabase>("posts", "insert")
      return null
    }
    await render(<Probe />)
    let answer: Awaited<ReturnType<UseMutationResult<unknown>["mutate"]>> | null = null
    await act(async () => {
      answer = await probe.hook!.mutate({ title: "a" })
    })
    expect(answer).toEqual({ data: null, error: thrown, count: null })
    expect(probe.hook!.error).toBe(thrown)
    expect(probe.hook!.loading).toBe(false)
    expect(reportsOf(logged, thrown)).toBe(1)
  })
})

describe("useFunction when the request throws", () => {
  it("answers and holds the thrown error, stops loading and reports it once", async () => {
    const thrown = new SetupFault()
    const using = client()
    vi.spyOn(using.functions, "invoke").mockRejectedValue(thrown)
    const logged = silenceConsole()
    const probe: { hook: UseFunctionResult<unknown> | null } = { hook: null }
    function Probe(): null {
      probe.hook = useFunction("process-order")
      return null
    }
    await render(<Probe />, using)
    let answer: Awaited<ReturnType<UseFunctionResult<unknown>["invoke"]>> | null = null
    await act(async () => {
      answer = await probe.hook!.invoke({ id: 1 })
    })
    expect(answer).toEqual({ data: null, error: thrown })
    expect(probe.hook!.error).toBe(thrown)
    expect(probe.hook!.loading).toBe(false)
    expect(reportsOf(logged, thrown)).toBe(1)
  })
})

describe("useAuth when starting the client throws", () => {
  it("stops loading, holds the thrown error and reports it once", async () => {
    const thrown = new SetupFault()
    const using = client()
    vi.spyOn(using.auth, "initialize").mockRejectedValue(thrown)
    const logged = silenceConsole()
    const probe: { hook: ReturnType<typeof useAuth> | null } = { hook: null }
    function Probe(): null {
      probe.hook = useAuth()
      return null
    }
    await render(<Probe />, using)
    expect(probe.hook!.loading).toBe(false)
    expect(probe.hook!.error).toBe(thrown)
    expect(reportsOf(logged, thrown)).toBe(1)
  })
})
