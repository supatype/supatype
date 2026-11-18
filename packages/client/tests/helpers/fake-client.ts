import type { AnyClient } from "../../src/index.js"
import type { SocketSwapHarness } from "./socket-swap.js"
import { isJsonObject } from "../../src/json.js"

function isAnyClient(value: unknown): value is AnyClient {
  return isJsonObject(value) && isJsonObject(value["realtime"]) && typeof value["from"] === "function"
}

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
  // The stand-in has only what `watchTable` touches, so that is what the guard below checks for.
  const client: unknown = { realtime: harness.realtime, from }
  if (!isAnyClient(client)) throw new Error("the fake client is missing what watchTable touches")
  return { client, filters }
}
