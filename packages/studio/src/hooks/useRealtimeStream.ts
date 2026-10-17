import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { bodyMessage, readJsonObject } from "../lib/json.js"
import {
  isStreamBroadcast,
  isStreamChange,
  isStreamPresence,
  isStreamReady,
  isStreamSampled,
} from "../lib/realtime-guards.js"
import { readSse, sseJson, type SseEvent } from "../lib/sse-reader.js"
import type { ProjectFetch } from "./usePlatformApi.js"
import type { ChangeEvent, StreamReady, StreamRow } from "../views/realtime/types.js"

/**
 * The Realtime Inspector's live stream: open, pause, clear, filter, and reconnect when the tab is
 * visible again.
 *
 * Filters are fixed for a stream's life on the server, so changing one closes the stream and opens
 * another. A hidden tab closes it: each Studio user may hold two streams and each realtime
 * instance five, and a forgotten tab should not hold one. Only the newest {@link STREAM_ROWS_MAX}
 * rows are kept.
 */

export const STREAM_ROWS_MAX = 1000

export type StreamKind = "all" | "change" | "broadcast" | "presence"

export interface StreamFilters {
  kind: StreamKind
  event: "" | ChangeEvent
  channel: string
  table: string
}

export const NO_FILTERS: StreamFilters = { kind: "all", event: "", channel: "", table: "" }

export type StreamStatus = "connecting" | "streaming" | "paused" | "closed" | "error"

export interface StreamState {
  status: StreamStatus
  ready: StreamReady | null
  /** Newest first. */
  rows: StreamRow[]
  error: string | null
  /** The control plane's error code when it refused to open the stream (e.g. `too_many_sessions`). */
  errorCode: string | null
}

export type StreamAction =
  | { type: "connecting" }
  | { type: "ready"; ready: StreamReady }
  | { type: "row"; row: StreamRow }
  | { type: "failed"; message: string; code: string | null }
  | { type: "closed" }
  | { type: "paused" }
  | { type: "clear" }

export const INITIAL_STREAM: StreamState = { status: "connecting", ready: null, rows: [], error: null, errorCode: null }

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case "connecting":
      return { ...state, status: "connecting", error: null, errorCode: null }
    case "ready":
      return { ...state, status: "streaming", ready: action.ready }
    case "row":
      return { ...state, rows: [action.row, ...state.rows].slice(0, STREAM_ROWS_MAX) }
    case "failed":
      return { ...state, status: "error", error: action.message, errorCode: action.code }
    case "closed":
      return state.status === "error" || state.status === "paused" ? state : { ...state, status: "closed" }
    case "paused":
      return { ...state, status: "paused" }
    case "clear":
      return { ...state, rows: [] }
  }
}

/** The action one SSE event stands for, or null for an event the Inspector does not show. */
export function actionFor(event: SseEvent): StreamAction | null {
  switch (event.event) {
    case "ready": {
      const ready = sseJson(event, isStreamReady)
      return ready ? { type: "ready", ready } : null
    }
    case "change": {
      const change = sseJson(event, isStreamChange)
      return change ? { type: "row", row: { kind: "change", change } } : null
    }
    case "broadcast": {
      const broadcast = sseJson(event, isStreamBroadcast)
      return broadcast ? { type: "row", row: { kind: "broadcast", broadcast } } : null
    }
    case "presence": {
      const presence = sseJson(event, isStreamPresence)
      return presence ? { type: "row", row: { kind: "presence", presence } } : null
    }
    case "sampled": {
      const sampled = sseJson(event, isStreamSampled)
      return sampled ? { type: "row", row: { kind: "sampled", ...sampled, key: `sampled-${sampled.since}-${sampled.skipped}` } } : null
    }
    default:
      return null
  }
}

/** The stream's query string for a set of filters. The view is the control plane's to choose. */
export function streamQuery(filters: StreamFilters): string {
  const params = new URLSearchParams()
  if (filters.kind !== "all") params.set("kinds", filters.kind)
  if (filters.event !== "") params.set("event", filters.event)
  if (filters.channel.trim() !== "") params.set("channel", filters.channel.trim())
  if (filters.table.trim() !== "") params.set("table", filters.table.trim())
  const query = params.toString()
  return query === "" ? "" : `?${query}`
}

/** Why a refused stream was refused, from the control plane's `{ error, message }` body. */
async function refusal(res: Response): Promise<StreamAction> {
  const body = await readJsonObject(res)
  const code = body["error"]
  return {
    type: "failed",
    message: bodyMessage(body) ?? `The stream could not be opened (${res.status})`,
    code: typeof code === "string" ? code : null,
  }
}

/** Open one stream and feed its events to `dispatch` until it ends or `signal` aborts it. */
export async function consumeStream(
  open: () => Promise<Response>,
  dispatch: (action: StreamAction) => void,
  signal: AbortSignal,
): Promise<void> {
  dispatch({ type: "connecting" })
  let res: Response
  try {
    res = await open()
  } catch (err) {
    if (!signal.aborted) dispatch({ type: "failed", message: err instanceof Error ? err.message : "Network error", code: null })
    return
  }
  if (!res.ok || res.body === null) {
    dispatch(await refusal(res))
    return
  }
  try {
    await readSse(res.body, (event) => {
      const action = actionFor(event)
      if (action) dispatch(action)
    }, signal)
    if (!signal.aborted) dispatch({ type: "closed" })
  } catch (err) {
    if (!signal.aborted) dispatch({ type: "failed", message: err instanceof Error ? err.message : "The stream failed", code: null })
  }
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden")
  useEffect(() => {
    if (typeof document === "undefined") return
    const update = (): void => setVisible(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])
  return visible
}

export interface RealtimeStream {
  state: StreamState
  paused: boolean
  setPaused: (paused: boolean) => void
  clear: () => void
  reconnect: () => void
}

export function useRealtimeStream(projectFetch: ProjectFetch | null, filters: StreamFilters): RealtimeStream {
  const [state, dispatch] = useReducer(streamReducer, INITIAL_STREAM)
  const [paused, setPaused] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const visible = useDocumentVisible()
  const fetchRef = useRef(projectFetch)
  fetchRef.current = projectFetch
  const query = streamQuery(filters)

  useEffect(() => {
    const fetcher = fetchRef.current
    if (fetcher === null || !visible) return
    if (paused) {
      dispatch({ type: "paused" })
      return
    }
    const controller = new AbortController()
    void consumeStream(
      () => fetcher(`realtime/stream${query}`, { signal: controller.signal, headers: { Accept: "text/event-stream" } }),
      dispatch,
      controller.signal,
    )
    return () => controller.abort()
  }, [query, paused, visible, attempt, projectFetch === null])

  const clear = useCallback(() => dispatch({ type: "clear" }), [])
  const reconnect = useCallback(() => setAttempt((n) => n + 1), [])

  // A stream the server ended (its 30-minute cap, a restart) reopens while somebody is looking.
  useEffect(() => {
    if (state.status !== "closed" || !visible || paused) return
    const timer = setTimeout(reconnect, 1000)
    return () => clearTimeout(timer)
  }, [state.status, visible, paused, reconnect])

  return { state, paused, setPaused, clear, reconnect }
}
