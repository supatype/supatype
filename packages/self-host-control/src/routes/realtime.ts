import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"
import type { ReadableStream as WebReadableStream } from "node:stream/web"
import { route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"
import { assertProject } from "../project.js"
import { studioCaller, type StudioCaller } from "../studio-caller.js"
import { audit, auditActor } from "../audit.js"
import {
  callRealtime,
  chooseView,
  permittedView,
  realtimeAdmin,
  type PayloadView,
} from "../realtime-admin-client.js"

/**
 * The Realtime Inspector's self-host routes.
 *
 *   GET  /projects/:ref/realtime/channels         realtime's channels, unchanged
 *   GET  /projects/:ref/realtime/connections      realtime's connections, with `tier: null`
 *   GET  /projects/:ref/realtime/stream           the live stream, in the view the caller may have
 *   POST /projects/:ref/realtime/broadcast        a test broadcast, audited without its payload
 *
 * The gateway admits admins and developers here (supatype-auth `IsRealtimeInspectorRoute`); this
 * side decides which payloads they see.
 */

type Routes = Array<{ method: string; pattern: RegExp; handler: RouteHandler }>

/** The stream's filters, forwarded as given: realtime validates them. */
const STREAM_FILTERS = ["channel", "schema", "table", "event", "kinds", "rate"] as const

/** Send realtime's JSON answer on, status and all, with anything added to `data`. */
async function relayJson(res: ServerResponse, upstream: Response, extra: Record<string, unknown> = {}): Promise<void> {
  const body = (await upstream.json()) as Record<string, unknown>
  const data = body["data"]
  if (upstream.ok && typeof data === "object" && data !== null) {
    sendJson(res, upstream.status, { ...body, data: { ...data, ...extra } })
    return
  }
  sendJson(res, upstream.status, body)
}

function streamQuery(url: URL, view: PayloadView): { query: string; filters: Record<string, string> } {
  const params = new URLSearchParams({ view })
  const filters: Record<string, string> = {}
  for (const name of STREAM_FILTERS) {
    const value = url.searchParams.get(name)
    if (value === null || value === "") continue
    params.set(name, value)
    filters[name] = value
  }
  return { query: params.toString(), filters }
}

/** One audit row per `delivered` stream, since it shows other users' data; the rest log a line. */
async function noteStream(caller: StudioCaller, view: PayloadView, filters: Record<string, string>): Promise<void> {
  if (view === "delivered") {
    await audit({ actorId: auditActor(caller.actor), action: "realtime_inspect", detail: { view, filters } })
    return
  }
  console.log(`[control-plane] realtime stream opened by ${caller.actor ?? "unknown"} (${view})`)
}

/** Pipe realtime's SSE response to the browser, ending realtime's when the browser goes. */
async function relayStream(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const caller = studioCaller(req)
  const admin = realtimeAdmin()
  const view = chooseView(url.searchParams.get("view"), permittedView(caller))
  const { query, filters } = streamQuery(url, view)

  const controller = new AbortController()
  const abort = (): void => controller.abort()
  req.on("close", abort)
  res.on("close", abort)

  const upstream = await callRealtime(admin, `/admin/v1/stream?${query}`, caller, {
    viewer: view === "viewer",
    signal: controller.signal,
  })
  if (!upstream.ok || upstream.body === null) {
    await relayJson(res, upstream)
    return
  }
  await noteStream(caller, view, filters)
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  })
  Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>)
    .on("error", () => res.end())
    .pipe(res)
}

async function broadcast(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const caller = studioCaller(req)
  const serialised = JSON.stringify(body ?? {})
  const upstream = await callRealtime(realtimeAdmin(), "/admin/v1/broadcast", caller, {
    method: "POST",
    body: serialised,
  })
  const answer = (await upstream.json()) as { data?: { recipients?: number } }
  if (upstream.ok) {
    const input = body as { channel?: unknown; event?: unknown; payload?: unknown }
    await audit({
      actorId: auditActor(caller.actor),
      action: "realtime_broadcast",
      detail: {
        channel: input.channel,
        event: input.event,
        payloadBytes: Buffer.byteLength(JSON.stringify(input.payload ?? {}), "utf8"),
        recipients: answer.data?.recipients ?? 0,
      },
    })
  }
  const retryAfter = upstream.headers.get("retry-after")
  if (retryAfter !== null) res.setHeader("Retry-After", retryAfter)
  sendJson(res, upstream.status, answer)
}

export function registerRealtimeRoutes(routes: Routes): void {
  route(routes, "GET", "/projects/:ref/realtime/channels", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    await relayJson(ctx.res, await callRealtime(realtimeAdmin(), "/admin/v1/channels", studioCaller(ctx.req)))
  })

  route(routes, "GET", "/projects/:ref/realtime/connections", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const url = new URL(ctx.req.url ?? "/", "http://localhost")
    const params = new URLSearchParams()
    for (const name of ["limit", "after"]) {
      const value = url.searchParams.get(name)
      if (value !== null && value !== "") params.set(name, value)
    }
    const query = params.toString()
    const path = `/admin/v1/connections${query === "" ? "" : `?${query}`}`
    await relayJson(ctx.res, await callRealtime(realtimeAdmin(), path, studioCaller(ctx.req)), { tier: null })
  })

  route(routes, "GET", "/projects/:ref/realtime/stream", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    await relayStream(ctx.req, ctx.res, new URL(ctx.req.url ?? "/", "http://localhost"))
  })

  route(routes, "POST", "/projects/:ref/realtime/broadcast", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    await broadcast(ctx.req, ctx.res, ctx.body)
  })
}
