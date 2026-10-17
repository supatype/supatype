/**
 * Narrowing for the JSON the suite reads back from the stack: response bodies, files it wrote.
 *
 * One small module rather than a cast per spec, so a body that is not the shape a test expected
 * fails as "not that shape" instead of as a property read on undefined three lines later.
 */

/** A JSON object whose keys can be read. Arrays and null are not. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** An array of JSON objects, which is what a PostgREST read answers with. */
export function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord)
}

/** The string at `key`, or undefined when the value is not an object or the key is not a string. */
export function stringAt(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const found = value[key]
  return typeof found === "string" ? found : undefined
}
