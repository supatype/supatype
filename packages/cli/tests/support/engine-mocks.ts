/**
 * Call shapes for the `target*` engine calls the command tests mock.
 *
 * A bare `vi.fn()` records its calls as `any[]`, so `mock.calls[0][2].yes` reads a property of `any`
 * and checks nothing about what the command sent. Typed with these, a test reads back exactly the
 * options it asserts on.
 */

/** `targetSchemaAdopt(target, ast, opts)` and its siblings, as a command calls them. */
export type TargetCall<TOptions> = (target: unknown, ast: unknown, opts: TOptions) => Promise<unknown>

/** What `supatype adopt` passes to `targetSchemaAdopt`. */
export interface AdoptCallOptions {
  yes?: boolean
  keys?: string[]
  release?: string[]
  reclaim?: string[]
}
