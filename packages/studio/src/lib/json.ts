/** `text` parsed as JSON, or null when it is not JSON: for a column that may arrive as its text. */
export function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** True for a JSON object: not null, not an array. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * A response's body as an object, or `{}` when it is not JSON or not an object.
 *
 * For error bodies, which may be neither: `res.json()` is typed `any`, so reading `.message` from
 * it directly checks nothing.
 */
export async function readJsonObject(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json().catch(() => null)
  return isJsonObject(body) ? body : {}
}

/** The body's `message`, when it is a string. */
export function bodyMessage(body: Record<string, unknown>): string | undefined {
  const message = body["message"]
  return typeof message === "string" ? message : undefined
}
