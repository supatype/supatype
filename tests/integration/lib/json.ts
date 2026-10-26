/**
 * Narrowing for the JSON the integration scripts read back: response bodies, catalogue dumps,
 * files the CLI wrote.
 *
 * One small module rather than a cast per script, so a body that is not the shape a check expected
 * fails as "not that shape" instead of as a property read on undefined further down.
 */

/** A JSON object whose keys can be read. Arrays and null are not. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** An array of JSON objects, which is what a PostgREST read answers with. */
export function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord)
}

/** The value at `key`, or undefined when the value is not an object. */
export function at(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

/** The string at `key`, or undefined when it is missing or not a string. */
export function stringAt(value: unknown, key: string): string | undefined {
  const found = at(value, key)
  return typeof found === "string" ? found : undefined
}

/** Column `key` of every row as a string. A row without one is an error that names it. */
export function stringColumn(rows: readonly Record<string, unknown>[] | null, key: string): string[] {
  return (rows ?? []).map((row) => {
    const value = row[key]
    if (typeof value !== "string") throw new Error(`row has no string ${key}: ${JSON.stringify(row)}`)
    return value
  })
}
