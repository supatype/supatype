/** A thrown value's message: an Error's own, or the value as text for anything else thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A thrown value's errno code (`ENOENT`, `EADDRINUSE`, ...), when it carries one as text. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined
  return typeof err.code === "string" ? err.code : undefined
}
