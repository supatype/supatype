/** `text` parsed as JSON, or null when it is not JSON: for a column that may arrive as its text. */
export function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}
