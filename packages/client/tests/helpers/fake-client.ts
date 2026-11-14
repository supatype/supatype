import type { AnyClient } from "../../src/index.js"
import type { SocketSwapHarness } from "./socket-swap.js"

/**
 * A client for `watchTable`: the harness's realtime client, and a `from(table)` whose reads answer
 * from a queue of row lists and record the filter conditions they were given.
 *
 * Not named `*.test.ts`, so vitest's default include does not collect it as a suite.
 */
export function fakeClient<TRow>(
  harness: SocketSwapHarness,
  reads: TRow[][] = [],
): { client: AnyClient; filters: string[][] } {
  const filters: string[][] = []
  const from = (): unknown => {
    const calls: string[] = []
    filters.push(calls)
    const query: Record<string, unknown> = {
      select: () => query,
      then: (resolve: (answer: { data: TRow[]; error: null }) => void) => resolve({ data: reads.shift() ?? [], error: null }),
    }
    for (const op of ["eq", "neq", "gt", "gte", "lt", "lte"]) {
      query[op] = (column: string, value: unknown) => {
        calls.push(`${column} ${op} ${String(value)}`)
        return query
      }
    }
    return query
  }
  // The stand-in has only what `watchTable` touches, so it is typed as the client at this one place.
  return { client: { realtime: harness.realtime, from } as unknown as AnyClient, filters }
}
