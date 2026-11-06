import { vi, describe, it, expect, afterEach, type MockInstance } from "vitest"
import { createClient, MutationBuilder, QueryBuilder, type AnyDatabase, type SupatypeClient } from "@supatype/client"

/**
 * What every framework binding owes a request that throws instead of answering `{ data, error }`.
 *
 * Some faults are thrown on purpose: a client with no API address or anon key throws from its first
 * request. The binding must stop loading, hold the thrown error as its `error`, and say so once on
 * the console. A returned `{ error }` must still arrive as before, unreported. Shared by the Vue,
 * Svelte and Solid suites over a real client, built from the package the bindings import, so the
 * prototypes spied on are the ones the bindings call. Not named `*.test.ts`, so vitest's default
 * include does not collect it as a suite.
 */
export interface BindingState {
  error(): unknown
  loading(): boolean
}

export interface ThrownErrorBinding {
  query(table: string): BindingState
  mutation(table: string): BindingState & { mutate(row: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> }
  invoker(name: string): BindingState & { invoke(body: unknown): Promise<{ data: unknown; error: unknown }> }
  auth(): BindingState
}

class SetupFault extends Error {
  constructor() {
    super("Supatype client has no API address")
    this.name = "SetupFault"
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Every read rejects with `thrown` when awaited, as a request that throws does. */
function readsReject(thrown: unknown): void {
  vi.spyOn(QueryBuilder.prototype, "then").mockImplementation((_onOk, onRejected) =>
    Promise.reject(thrown).then(undefined, onRejected),
  )
}

/** Every write rejects with `thrown` when awaited. */
function writesReject(thrown: unknown): void {
  vi.spyOn(MutationBuilder.prototype, "then").mockImplementation((_onOk, onRejected) =>
    Promise.reject(thrown).then(undefined, onRejected),
  )
}

/** The console.error calls that carry `thrown`. */
function reportsOf(logged: MockInstance<typeof console.error>, thrown: unknown): number {
  return logged.mock.calls.filter((call) => call.includes(thrown)).length
}

function refusingFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ message: "permission denied", code: "42501" }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  )))
}

function expectThrownHeld(state: BindingState, thrown: unknown, logged: MockInstance<typeof console.error>): void {
  expect(state.loading()).toBe(false)
  expect(state.error()).toBe(thrown)
  expect(reportsOf(logged, thrown)).toBe(1)
}

export function describeThrownErrorBinding(
  name: string,
  mount: (client: SupatypeClient<AnyDatabase>) => ThrownErrorBinding,
  unmount: () => void,
): void {
  describe(`${name} when a request throws`, () => {
    const client = (): SupatypeClient<AnyDatabase> => createClient<AnyDatabase>({ url: "http://localhost:9999", anonKey: "anon" })
    const thrown = new SetupFault()
    const silence = (): MockInstance<typeof console.error> => vi.spyOn(console, "error").mockImplementation(() => undefined)

    afterEach(() => {
      unmount()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    })

    it("a query stops loading, holds the thrown error and reports it once", async () => {
      readsReject(thrown)
      const logged = silence()
      const state = mount(client()).query("posts")
      await settle()
      expectThrownHeld(state, thrown, logged)
    })

    it("a query still holds a returned error, unreported", async () => {
      refusingFetch()
      const logged = silence()
      const state = mount(client()).query("posts")
      await vi.waitFor(() => expect(state.loading()).toBe(false))
      expect(state.error()).toMatchObject({ message: "permission denied" })
      expect(logged).not.toHaveBeenCalled()
    })

    it("a mutation answers and holds the thrown error and reports it once", async () => {
      writesReject(thrown)
      const logged = silence()
      const state = mount(client()).mutation("posts")
      await expect(state.mutate({ title: "a" })).resolves.toMatchObject({ data: null, error: thrown })
      expectThrownHeld(state, thrown, logged)
    })

    it("a function call answers and holds the thrown error and reports it once", async () => {
      const using = client()
      vi.spyOn(using.functions, "invoke").mockRejectedValue(thrown)
      const logged = silence()
      const state = mount(using).invoker("process-order")
      await expect(state.invoke({ id: 1 })).resolves.toEqual({ data: null, error: thrown })
      expectThrownHeld(state, thrown, logged)
    })

    it("auth stops loading, holds the thrown error and reports it once when starting throws", async () => {
      const using = client()
      vi.spyOn(using.auth, "initialize").mockRejectedValue(thrown)
      const logged = silence()
      const state = mount(using).auth()
      await settle()
      expectThrownHeld(state, thrown, logged)
    })
  })
}
