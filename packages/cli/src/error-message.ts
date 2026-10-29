/**
 * A thrown value's message: an Error's own, or the value as text for anything else thrown.
 *
 * Never empty. Node reports a refused connection to `localhost` as an AggregateError whose own
 * message is empty, with one inner error per address it tried, so every command that printed
 * `err.message` printed a blank line (`[supatype] ` from push, "Failed to list admin users: ").
 * An error with nothing to say is described by its inner errors, then its code, then its name.
 */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  if (err.message.trim() !== "") return err.message
  return describeSilentError(err)
}

/** A thrown value's errno code (`ENOENT`, `EADDRINUSE`, ...), when it carries one as text. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined
  return typeof err.code === "string" ? err.code : undefined
}

/** What Node's network errors mean, in words, by their code. */
const NETWORK_FAILURES: Readonly<Record<string, string>> = {
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection reset",
  ETIMEDOUT: "connection timed out",
  EHOSTUNREACH: "host unreachable",
  ENETUNREACH: "network unreachable",
  ENOTFOUND: "host not found",
  EAI_AGAIN: "host lookup failed",
}

/** An Error whose message is empty, described by what else it carries. */
function describeSilentError(err: Error): string {
  const inner = err instanceof AggregateError ? err.errors : []
  if (inner.length > 0) return describeInnerErrors(inner)
  const failure = networkFailure(err)
  if (failure === undefined) return errorCode(err) ?? err.name
  return failure.where === undefined ? failure.what : `${failure.what} at ${failure.where}`
}

/** One network failure: what happened, and where when the error says. */
interface NetworkFailure {
  what: string
  where: string | undefined
}

function networkFailure(err: unknown): NetworkFailure | undefined {
  const code = errorCode(err)
  const what = code === undefined ? undefined : NETWORK_FAILURES[code]
  return what === undefined ? undefined : { what, where: errorAddress(err) }
}

/** `host:port` from an errno error's `address` and `port`, an IPv6 host in brackets. */
function errorAddress(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("address" in err)) return undefined
  const { address } = err
  if (typeof address !== "string" || address === "") return undefined
  const host = address.includes(":") ? `[${address}]` : address
  const port = "port" in err && typeof err.port === "number" ? `:${err.port}` : ""
  return `${host}${port}`
}

/**
 * The inner errors of an AggregateError as one line. Failures of one kind read as one, naming each
 * address tried ("connection refused at [::1]:5432, 127.0.0.1:5432"); anything else keeps each
 * error's own words.
 */
function describeInnerErrors(errors: readonly unknown[]): string {
  const failures = errors.map(networkFailure)
  const what = failures[0]?.what
  const where = failures.map((failure) => failure?.where)
  if (what !== undefined && failures.every((failure) => failure?.what === what) && where.every((w) => w !== undefined)) {
    return `${what} at ${where.join(", ")}`
  }
  return [...new Set(errors.map(errorMessage))].join("; ")
}
