import type { IncomingMessage, ServerResponse } from "node:http"
import { AdminError } from "./http.js"
import { actorOf, viewerClaims } from "./auth.js"
import { TAP_KINDS, Tap, TapSession, type TapFilters, type TapKind } from "./tap.js"
import { PAYLOAD_VIEWS, viewRenderer, type PayloadView, type ViewRules } from "./views.js"

/**
 * `GET /admin/v1/stream`: the inspector's live stream, as Server-Sent Events.
 *
 * SSE rather than a WebSocket because the browser end reads it through `fetch`, the only way it can
 * send its session in a header: a WebSocket cannot, and a token in a query string lands in access
 * logs.
 */

export const STREAM_RATE_DEFAULT = 20
export const STREAM_RATE_MAX = 100
export const SESSIONS_PER_INSTANCE = 5
export const SESSIONS_PER_ACTOR = 2
/** A comment line this often keeps idle hops open: Kong reads for 60 s, Cloud's proxy idles at 30 s. */
export const HEARTBEAT_MS = 15_000
/** A session ends after this long; Studio reconnects while its tab is visible. */
export const SESSION_MAX_MS = 30 * 60_000

export interface StreamDeps {
  tap: Tap
  rules: ViewRules
  /** The secret a viewer's token must be signed with: the subscribers' secret. */
  secret: string
}

interface StreamRequest {
  view: PayloadView
  rate: number
  filters: TapFilters
}

function exactFilters(url: URL): Omit<TapFilters, "kinds"> {
  const pick = (name: string): string | undefined => {
    const value = url.searchParams.get(name)
    return value === null || value === "" ? undefined : value
  }
  return { channel: pick("channel"), schema: pick("schema"), table: pick("table"), event: pick("event") }
}

const isTapKind = (kind: string): kind is TapKind => TAP_KINDS.some((known) => known === kind)

function parseKinds(raw: string | null): ReadonlySet<TapKind> {
  if (raw === null || raw.trim() === "") return new Set(TAP_KINDS)
  const kinds = raw.split(",").map((k) => k.trim())
  const unknown = kinds.filter((k) => !isTapKind(k))
  if (unknown.length > 0) throw new AdminError(400, "validation_error", `Unknown kinds: ${unknown.join(", ")}`)
  return new Set(kinds.filter(isTapKind))
}

function parseRate(raw: string | null): number {
  if (raw === null || raw === "") return STREAM_RATE_DEFAULT
  const rate = Number(raw)
  if (!Number.isInteger(rate) || rate < 1 || rate > STREAM_RATE_MAX) {
    throw new AdminError(400, "validation_error", `rate must be a whole number from 1 to ${STREAM_RATE_MAX}`)
  }
  return rate
}

function parseView(raw: string | null): PayloadView {
  const view = PAYLOAD_VIEWS.find((known) => known === raw)
  if (view === undefined) {
    throw new AdminError(400, "validation_error", `view must be one of ${PAYLOAD_VIEWS.join(", ")}`)
  }
  return view
}

function parseStreamRequest(url: URL): StreamRequest {
  return {
    view: parseView(url.searchParams.get("view")),
    rate: parseRate(url.searchParams.get("rate")),
    filters: { ...exactFilters(url), kinds: parseKinds(url.searchParams.get("kinds")) },
  }
}

function admitSession(tap: Tap, actor: string): void {
  if (tap.size >= SESSIONS_PER_INSTANCE || tap.sessionsFor(actor) >= SESSIONS_PER_ACTOR) {
    throw new AdminError(429, "too_many_sessions", "Too many inspector streams are open; close one and retry")
  }
}

/** Open a stream on `res`, or throw an {@link AdminError} before anything is written. */
export function openStream(req: IncomingMessage, res: ServerResponse, url: URL, deps: StreamDeps): void {
  const request = parseStreamRequest(url)
  const viewer = request.view === "viewer" ? viewerClaims(req, deps.secret) : null
  if (request.view === "viewer" && viewer === null) {
    throw new AdminError(400, "validation_error", "view=viewer needs the viewer's verified token")
  }
  const actor = actorOf(req)
  admitSession(deps.tap, actor)

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  })
  const session = new TapSession({
    actor,
    filters: request.filters,
    rate: request.rate,
    sink: { write: (chunk) => res.write(chunk), onDrain: (listener) => res.once("drain", listener) },
    render: viewRenderer({ view: request.view, viewer, channel: request.filters.channel, rules: deps.rules }),
  })
  const { kinds, ...exact } = request.filters
  session.writeEvent("ready", { view: request.view, rate: request.rate, filters: { ...definedOnly(exact), kinds: [...kinds].join(",") } })
  deps.tap.add(session)
  keepAlive(req, res, session)
}

function definedOnly(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((e): e is [string, string] => e[1] !== undefined))
}

/** Heartbeats while open; one end for the session and the response, however it ends. */
function keepAlive(req: IncomingMessage, res: ServerResponse, session: TapSession): void {
  const heartbeat = setInterval(() => session.ping(), HEARTBEAT_MS)
  const cap = setTimeout(() => finish(), SESSION_MAX_MS)
  heartbeat.unref()
  cap.unref()
  let finished = false
  function finish(): void {
    if (finished) return
    finished = true
    clearInterval(heartbeat)
    clearTimeout(cap)
    session.close()
    res.end()
  }
  req.on("close", finish)
  res.on("close", finish)
}
