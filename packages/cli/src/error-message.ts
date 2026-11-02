import { isJsonObject, parseJsonObject } from "@supatype/shared"

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

/** How a child process ended, as far as its failure text needs. */
export interface SpawnOutcome {
  status: number | null
  stderr?: string | null | undefined
  stdout?: string | null | undefined
  /** Why it could not run: a spawn error's message. */
  error?: string | undefined
  timedOut?: boolean | undefined
}

/**
 * Why a child process failed, in one line of its own words: its stderr, or why it could not run,
 * or its stdout, or how it ended. Each caller used to pick its own subset in its own order, and
 * some printed an empty string for a process that said nothing.
 */
export function spawnFailureText(outcome: SpawnOutcome): string {
  const said = [outcome.stderr, outcome.error, outcome.stdout].map((text) => (text ?? "").trim()).find((text) => text !== "")
  if (said !== undefined) return said
  return outcome.timedOut === true ? "it did not answer in time" : `exit ${outcome.status ?? "unknown"}`
}

/** A JSON body's own reason for a refusal: its string `message`, else its `error`; never blank. */
export function bodyReason(body: unknown): string | undefined {
  if (!isJsonObject(body)) return undefined
  return [body["message"], body["error"]].find((said): said is string => typeof said === "string" && said.trim() !== "")
}

/** The most of a response body a failure line quotes. */
const BODY_QUOTE_LIMIT = 300

/**
 * Why an HTTP request failed, never blank: its status, its status text when it has one, then what
 * the body said. A gateway with no upstream answers 502 with an empty body, and a status text is
 * often empty too, so printing the body or the status text alone gave
 * `Failed to provision bucket "big": ` with nothing after it (local test round 3, N3).
 */
export function httpFailureText(status: number, statusText: string, body: string): string {
  const head = statusText.trim() === "" ? `HTTP ${status}` : `HTTP ${status} ${statusText.trim()}`
  const parsed = parseJsonObject(body)
  const said = ((parsed.ok ? bodyReason(parsed.value) : undefined) ?? body).trim().replace(/\s+/g, " ")
  if (said === "") return `${head}, with an empty body`
  return `${head}: ${said.length > BODY_QUOTE_LIMIT ? `${said.slice(0, BODY_QUOTE_LIMIT)}...` : said}`
}

/** {@link httpFailureText} for a response whose body has not been read yet. */
export async function responseFailureText(res: Response): Promise<string> {
  const body = await res.text().catch((err: unknown) => `(its body could not be read: ${errorMessage(err)})`)
  return httpFailureText(res.status, res.statusText, body)
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
