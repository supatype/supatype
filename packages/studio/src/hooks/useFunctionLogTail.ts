import { useEffect, useRef, useState } from "react"

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
 * `retry:` and comment lines are part of the protocol rather than content, and a line that is not
 * JSON is skipped rather than allowed to end the tail.
 *
 * Those two guards overlap for any real stream: a non-`data:` field fails to parse anyway, because
 * slicing five characters off it does not leave JSON. The prefix check is kept because it states
 * the intent, not because the `catch` could not cover it.
 */
export function parseTailEvents(
  buffered: string,
  functionName: string,
): { lines: FunctionLogLine[]; rest: string } {
  const events = buffered.split("\n\n")
  const rest = events.pop() ?? ""
  const lines: FunctionLogLine[] = []

  for (const event of events) {
    for (const raw of event.split("\n")) {
      if (!raw.startsWith("data:")) continue
      try {
        const line = JSON.parse(raw.slice(5).trim()) as FunctionLogLine
        // The stream carries every function's lines, and the worker's own. This tab is about one
        // function, so the rest would read as somebody else's output.
        if (line.function === functionName) lines.push(line)
      } catch {
        // A truncated or non-JSON line is not worth taking the tail down for.
      }
    }
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
