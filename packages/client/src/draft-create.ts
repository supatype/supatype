/**
 * The pure half of creating records on a drafts model: which function to call, what it answered,
 * and the rows read back in the order they were sent.
 *
 * One record goes through `supatype.create_record`, several through `supatype.create_records`,
 * which runs `create_record` for each inside one call, so a refused record takes the ones before it
 * with it. One call per row would not be all or nothing, and PostgREST cannot batch an RPC.
 */
import { isJsonObject } from "./json.js"

/**
 * The column the draft read-back carries a new record's key under, to put the rows in the order
 * they were sent, whatever the insert's select names. Removed before the caller sees a row.
 */
const ORDER_KEY = "__supatype_created_key"

/** The function a write of `body` creates its records through, and the `data` it sends. */
export function createCall(body: unknown): { fn: "create_record" | "create_records"; data: unknown } {
  if (Array.isArray(body) && body.length > 1) return { fn: "create_records", data: body }
  return { fn: "create_record", data: Array.isArray(body) ? body[0] : body }
}

/** The new keys an answer names: `create_record`'s one object, or `create_records`' array of them. */
export function createdKeys(answer: unknown): string[] | null {
  const answers = Array.isArray(answer) ? answer : [answer]
  const keys = answers.map((one) => (isJsonObject(one) ? one["record_id"] : undefined))
  return keys.every((key): key is string => typeof key === "string") ? keys : null
}

/** The select the read-back sends: the insert's own, plus the key to order several rows by. */
export function readBackColumns(select: string | null, primaryKey: string, count: number): string | undefined {
  if (count < 2) return select ?? undefined
  return `${select ?? "*"},${ORDER_KEY}:${primaryKey}`
}

/** The rows read back, in the order their records were sent, without the ordering key. */
export function inCreatedOrder(
  rows: readonly Record<string, unknown>[],
  keys: readonly string[],
): Record<string, unknown>[] {
  if (keys.length < 2) return [...rows]
  const byKey = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const { [ORDER_KEY]: key, ...rest } = row
    byKey.set(String(key), rest)
  }
  return keys.flatMap((key) => {
    const row = byKey.get(key)
    return row === undefined ? [] : [row]
  })
}
