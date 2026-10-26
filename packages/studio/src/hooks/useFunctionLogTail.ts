import { useEffect, useRef, useState } from "react"
import { isNumber, isOneOf, isShape, isString, optional, type Guard } from "../lib/json.js"
import { parseSseEvents, sseJson } from "../lib/sse-reader.js"

/** One structured line as the worker writes it. */
export interface FunctionLogLine {
  timestamp: string
  level: "debug" | "info" | "warn" | "error"
  project_ref: string
  request_id?: string
  function?: string
  message: string
  status?: number
  duration_ms?: number
}

/** The worker's `LogLine` (`packages/functions-worker/logging.ts`), less the keys Studio does not read. */
const isFunctionLogLine: Guard<FunctionLogLine> = isShape({
  timestamp: isString,
  level: isOneOf(["debug", "info", "warn", "error"] as const),
  project_ref: isString,
  request_id: optional(isString),
  function: optional(isString),
  message: isString,
  status: optional(isNumber),
  duration_ms: optional(isNumber),
})

export type TailState =
  | { kind: "connecting" }
  | { kind: "streaming" }
  /** This deployment runs functions in-process, so there is no worker to tail. */
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

export interface FunctionLogTail {
  lines: FunctionLogLine[]
  state: TailState
  clear: () => void
}

/**
 * Split a stream buffer into the lines it completes, keeping whatever is unfinished.
 *
 * Separate from the effect so the chunk-boundary cases are testable without a network: an event can
 * be cut anywhere, and a parser that assumes one chunk is one event drops lines under load and only
 * under load.
 *
 * `retry:` and comment lines are part of the protocol rather than content (the shared reader in
 * `lib/sse-reader.ts` drops them), and a line that is not JSON is skipped rather than allowed to end
 * the tail.
 */
export function parseTailEvents(
  buffered: string,
  functionName: string,
): { lines: FunctionLogLine[]; rest: string } {
  const { events, rest } = parseSseEvents(buffered)
  const lines: FunctionLogLine[] = []
  for (const event of events) {
    const line = sseJson(event, isFunctionLogLine)
    // The stream carries every function's lines, and the worker's own. This tab is about one
    // function, so the rest would read as somebody else's output.
    if (line !== null && line.function === functionName) lines.push(line)
  }
  return { lines, rest }
}

/**
 * A live tail of one function's logs.
 *
 * # Why fetch and not EventSource
 *
 * `EventSource` cannot set request headers, and this route is behind the Studio proxy, which
 * authenticates from the caller's session token. The only way to pass a token to `EventSource` is
 * in the query string, which puts a credential in every access log between here and the server.
 * Reading the body as a stream costs a few lines more and keeps the token in a header.
 *
 * # Why a tail and not a query
 *
 * The per-function `logs` route answers from the server's own Deno manager, which exists only when
 * the server supervises Deno itself. In Compose and on cloud the functions run in a separate
 * worker, so that route returns an empty list: the read API was there and nothing wrote to it. The
 * worker streams instead, and nothing is stored, so there is no retention to configure and no table
 * in anybody's database. Cloud keeps history in Loki separately.
 *
 * A deployment with no worker answers 501, which is reported as `unsupported` rather than as a
 * failure so the caller can fall back to the query route.
 */
export function useFunctionLogTail(
  functionName: string,
  open: boolean,
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>,
  limit = 500,
): FunctionLogTail {
  const [lines, setLines] = useState<FunctionLogLine[]>([])
  const [state, setState] = useState<TailState>({ kind: "connecting" })

  // The callback identity changes with the client, and the effect must not re-open the stream on
  // every render just because a new closure was made.
  const fetchRef = useRef(adminFetch)
  fetchRef.current = adminFetch

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setState({ kind: "connecting" })
    setLines([])

    void (async () => {
      let response: Response
      try {
        response = await fetchRef.current("/logs/tail", {
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        })
      } catch (err) {
        if (!controller.signal.aborted) {
          setState({ kind: "error", message: err instanceof Error ? err.message : "Network error" })
        }
        return
      }

      if (response.status === 501) {
        setState({ kind: "unsupported" })
        return
      }
      if (!response.ok || response.body === null) {
        setState({ kind: "error", message: `Could not open the log stream (${response.status})` })
        return
      }

      setState({ kind: "streaming" })
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffered = ""

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffered += decoder.decode(value, { stream: true })

          const { lines: parsed, rest } = parseTailEvents(buffered, functionName)
          buffered = rest
          if (parsed.length > 0) {
            setLines((prev) => [...prev, ...parsed].slice(-limit))
          }
        }
        if (!controller.signal.aborted) {
          setState({ kind: "error", message: "The log stream ended" })
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setState({ kind: "error", message: err instanceof Error ? err.message : "Stream failed" })
        }
      }
    })()

    return () => {
      controller.abort()
    }
  }, [functionName, open, limit])

  return { lines, state, clear: () => setLines([]) }
}
