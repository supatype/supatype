import { isJsonObject, type Guard } from "../../src/json.js"

/** `value` when the guard accepts it; fails the test, showing what arrived, when it does not. */
export function expectJson<T>(value: unknown, guard: Guard<T>): T {
  if (!guard(value)) throw new Error(`Unexpected JSON: ${JSON.stringify(value)}`)
  return value
}

/** `value` as a JSON object, failing the test when it is not one. */
export function expectObject(value: unknown): Record<string, unknown> {
  return expectJson(value, isJsonObject)
}
