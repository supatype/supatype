/**
 * Reading JSON from outside the program: a response body, a stored column, text a person typed.
 *
 * `res.json()` and `JSON.parse` return `unknown` here (see ts-reset.d.ts at the repository root), and
 * a cast cannot turn that into a type (`no-unsafe-type-assertion`). A value is narrowed by a guard
 * instead: the small ones below, composed with `isShape` and `isArrayOf` for a body's shape.
 */

/** A check that narrows an unknown value to `T`. */
export type Guard<T> = (value: unknown) => value is T

/** True for a JSON object: not null, not an array. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isString(value: unknown): value is string {
  return typeof value === "string"
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number"
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

/** Accepts anything: for a key whose value is read with its own checks later. */
export function isUnknown(_value: unknown): _value is unknown {
  return true
}

/** An array whose every item the guard accepts. */
export function isArrayOf<T>(item: Guard<T>): Guard<T[]> {
  return (value: unknown): value is T[] => Array.isArray(value) && value.every(item)
}

/** An object whose every value the guard accepts. */
export function isRecordOf<T>(item: Guard<T>): Guard<Record<string, T>> {
  return (value: unknown): value is Record<string, T> => isJsonObject(value) && Object.values(value).every(item)
}

/** The guard's type, or null. */
export function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value: unknown): value is T | null => value === null || guard(value)
}

/** One of the listed values, by identity. */
export function isOneOf<const T extends readonly (string | number | boolean)[]>(values: T): Guard<T[number]> {
  return (value: unknown): value is T[number] => values.some((allowed) => allowed === value)
}

/** A key that may be absent: `isShape` types it as an optional property. */
export interface Optional<T> {
  readonly optional: Guard<T>
}

export function optional<T>(guard: Guard<T>): Optional<T> {
  return { optional: guard }
}

type Field = Guard<unknown> | Optional<unknown>
type Shape = Readonly<Record<string, Field>>
type Guarded<F> = F extends Guard<infer T> ? T : F extends Optional<infer T> ? T : never
type RequiredKeys<S extends Shape> = { [K in keyof S]: S[K] extends Optional<unknown> ? never : K }[keyof S]
type OptionalKeys<S extends Shape> = Exclude<keyof S, RequiredKeys<S>>

/** The object type a shape accepts. */
export type FromShape<S extends Shape> = { [K in RequiredKeys<S>]: Guarded<S[K]> } & {
  [K in OptionalKeys<S>]?: Guarded<S[K]>
}

function fieldAccepts(field: Field, value: unknown): boolean {
  if (typeof field === "function") return field(value)
  return value === undefined || field.optional(value)
}

/** A JSON object whose named keys each pass their guard. Keys not named are allowed and not typed. */
export function isShape<S extends Shape>(shape: S): Guard<FromShape<S>> {
  return (value: unknown): value is FromShape<S> =>
    isJsonObject(value) && Object.entries(shape).every(([key, field]) => fieldAccepts(field, value[key]))
}

/** A response's JSON body when the guard accepts it; throws, naming the request, when it does not. */
export async function readJson<T>(res: Response, guard: Guard<T>): Promise<T> {
  const body = await res.json()
  if (!guard(body)) throw new Error(`Unexpected response from ${res.url || "the server"} (HTTP ${res.status})`)
  return body
}

/** `text` parsed as JSON, or null when it is not JSON: for a column that may arrive as its text. */
export function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** `text` parsed as a JSON object, or which of the two ways it is not one. */
export type ParsedJsonObject =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: "not-json" | "not-object" }

export function parseJsonObject(text: string): ParsedJsonObject {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, error: "not-json" }
  }
  return isJsonObject(value) ? { ok: true, value } : { ok: false, error: "not-object" }
}

/**
 * True when two JSON values say the same thing: the same scalars, the same items in the same order,
 * and the same keys with the same values in any order.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]))
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameJson(a[key], b[key]))
  }
  return a === b
}

/** A response's body as an object, or `{}` when it is not JSON or not an object. For error bodies. */
export async function readJsonObject(res: Response): Promise<Record<string, unknown>> {
  const body = await res.json().catch(() => null)
  return isJsonObject(body) ? body : {}
}

/** The body's `message`, when it is a string. */
export function bodyMessage(body: Record<string, unknown>): string | undefined {
  const message = body["message"]
  return typeof message === "string" ? message : undefined
}
