import { AsyncLocalStorage } from "node:async_hooks"

/**
 * What a function is told about the call it is serving, and the store that carries it.
 *
 * # Why this exists at all
 *
 * The worker used to deliver this through `Deno.env`: it set `SUPATYPE_SERVICE_ROLE_KEY` and the
 * rest before calling the handler and restored them afterwards. `Deno.env` is process-global, so
 * two concurrent invocations would read each other's values — including a service-role key granted
 * to one route and not the other. The defence was a lock held across the *whole* handler, so the
 * worker executed exactly one invocation at a time.
 *
 * That is a throughput property nobody chose: a function waiting two seconds on a third-party API
 * blocked every other function in the project for two seconds, and on cloud there is one worker per
 * project. It was invisible because `supatype dev` generates a router with the same lock, so local
 * behaved exactly like production.
 *
 * Nothing per-invocation goes into the environment now. It is passed to the handler as a second
 * argument and carried here for the things a handler cannot be handed directly, so there is no
 * global to protect and no reason to serialise.
 *
 * # What is *not* here
 *
 * `SUPATYPE_URL`, `SUPATYPE_ANON_KEY` and the other invariants. Those are set once by compose or by
 * the deployment and never differ between invocations, so they stay in the environment where they
 * already are. The old code read each one out of the environment and set it straight back, which
 * looked like scoping and achieved nothing.
 */
export interface FunctionContext {
  /** Unique to this invocation. Every log line it writes carries the same value. */
  readonly executionId: string
  /** The function or hook route being served. */
  readonly functionName: string
  /** The project's API base URL, reachable from inside this container. */
  readonly url: string
  readonly anonKey: string
  /**
   * Present only for a route the project granted it.
   *
   * Withheld from the process environment before any handler is imported, so a function that was
   * not granted it cannot reach it by reading `Deno.env` either.
   */
  readonly serviceRoleKey?: string
  readonly dbUrl?: string
  readonly region: string
  /** Values from `.env` and `.env.<function>.local`, which are per-route rather than per-call. */
  readonly env: Readonly<Record<string, string>>
}

/** The parts the worker needs internally but a handler has no use for. */
interface InvocationStore {
  readonly context: FunctionContext
  /**
   * The hook-depth header to carry onto outbound calls, when this invocation is a hook.
   *
   * Here rather than patched onto `globalThis.fetch` per call. That patch was the second global
   * mutation the lock was protecting: two concurrent hooks would patch over each other, and the
   * first to finish would restore the other's patch.
   */
  readonly hookDepth: string | null
}

const store = new AsyncLocalStorage<InvocationStore>()

/** Run an invocation with its context available to everything it calls. */
export function runInvocation<T>(
  context: FunctionContext,
  hookDepth: string | null,
  run: () => Promise<T>,
): Promise<T> {
  return store.run({ context, hookDepth }, run)
}

/** The invocation being served on this call stack, or undefined outside one. */
export function currentInvocation(): FunctionContext | undefined {
  return store.getStore()?.context
}

/** The hook depth to propagate, or null when this is not a hook call. */
export function currentHookDepth(): string | null {
  return store.getStore()?.hookDepth ?? null
}
