import { isJsonObject } from "@supatype/shared"
import { ProcessManager } from "./process-manager.js"
import { errorMessage } from "./error-message.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import { resolveRealtimeLaunch, type RealtimeLaunchSpec } from "./realtime-launch.js"
import { patchRouteManifest } from "./route-manifest.js"

export interface NativeRealtimeOptions {
  config: SupatypeProjectConfig
  cwd: string
  manifestPath: string
  pidDir: string
  /** Where realtime listens, as the gateway reaches it. */
  url: string
  port: string
  databaseUrl: string
  jwtSecret: string
  /** How long realtime has to answer before it is reported not running. */
  readyTimeoutMs?: number
}

type ResolveLaunch = (config: SupatypeProjectConfig, cwd: string) => Promise<RealtimeLaunchSpec>

/** What realtime's `/health/ready` said, or that it said nothing. */
type RealtimeState =
  | { kind: "ready" }
  | { kind: "unsupported"; reason: string }
  | { kind: "connecting" }
  | { kind: "silent" }
  | { kind: "exited" }

/** Long enough for a cold start beside a Postgres that is already up. */
const READY_TIMEOUT_MS = 15_000
const READY_POLL_MS = 250

function spawnRealtime(launch: RealtimeLaunchSpec, opts: NativeRealtimeOptions, onExit: () => void): ProcessManager {
  const proc = new ProcessManager(launch.bin, launch.args, {
    label: "realtime",
    pidDir: opts.pidDir,
    colour: "\x1b[35m",
    env: {
      DATABASE_URL: opts.databaseUrl,
      JWT_SECRET: opts.jwtSecret,
      PORT: opts.port,
      SLOT_NAME: "supatype_realtime",
      PUBLICATION_NAME: "supatype_realtime",
    },
    // A clean exit only: ProcessManager restarts realtime after any other.
    onExit,
  })
  proc.start()
  return proc
}

/**
 * Start realtime for native dev, and record in the route manifest whether it is running.
 *
 * The manifest is what the gateway routes /realtime/v1 by. Enabled with nothing listening, it
 * proxies every subscription to a dead port and answers a bare 502, and its /health reports the
 * whole stack not ready. Disabled, it answers "realtime disabled" and health leaves realtime out.
 * `realtime_url` is dropped too, so a URL from an earlier run is not left pointing at nothing.
 *
 * Running means answering. Dev used to enable realtime and print its URL the moment the process
 * was spawned, so a realtime that exited at once, or disabled its database changes for want of
 * logical decoding, was announced as running all the same (local test N3).
 */
export async function startNativeRealtime(
  opts: NativeRealtimeOptions,
  resolveLaunch: ResolveLaunch = resolveRealtimeLaunch,
): Promise<ProcessManager | null> {
  // A clean exit before realtime answered ends the wait; one after it means it has gone, and the
  // gateway stops routing subscriptions to its port.
  const gone = new AbortController()
  let announced = false
  const exited = new Promise<RealtimeState>((resolve) => gone.signal.addEventListener("abort", () => resolve({ kind: "exited" })))
  const manifestPath = opts.manifestPath
  const onExit = (): void => (announced ? disableRealtime(manifestPath, "Realtime exited.") : gone.abort())
  let proc: ProcessManager
  try {
    proc = spawnRealtime(await resolveLaunch(opts.config, opts.cwd), opts, onExit)
  } catch (err) {
    return realtimeNotRunning(opts, errorMessage(err))
  }
  const timeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS
  const state = await Promise.race([exited, awaitReady(opts.url, timeoutMs, gone.signal)])
  if (state.kind === "exited" || state.kind === "silent") {
    await proc.stop()
    return realtimeNotRunning(opts, notRunningReason(state.kind, opts.url, timeoutMs))
  }
  announced = true
  announceRealtime(opts, state)
  return proc
}

/** Ask `/health/ready` until it answers for good, the time is up or `gone` aborts; the last answer. */
async function awaitReady(url: string, timeoutMs: number, gone: AbortSignal): Promise<RealtimeState> {
  const deadline = Date.now() + timeoutMs
  let state: RealtimeState = { kind: "silent" }
  while (!gone.aborted && Date.now() < deadline) {
    state = await probeReady(url)
    if (state.kind === "ready" || state.kind === "unsupported") return state
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
  }
  return state
}

async function probeReady(url: string): Promise<RealtimeState> {
  try {
    const res = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(1_000) })
    // 404: a realtime from before /health/ready, which answers, and so is up.
    if (res.ok || res.status === 404) return { kind: "ready" }
    const reason = unsupportedReason(await res.json().catch(() => undefined))
    return reason === undefined ? { kind: "connecting" } : { kind: "unsupported", reason }
  } catch {
    return { kind: "silent" }
  }
}

/** The reason in realtime's "unsupported" readiness answer (packages/realtime/src/server.ts). */
function unsupportedReason(body: unknown): string | undefined {
  if (!isJsonObject(body) || body["status"] !== "unsupported") return undefined
  return typeof body["reason"] === "string" ? body["reason"] : "the database cannot stream changes"
}

function notRunningReason(kind: "exited" | "silent", url: string, timeoutMs: number): string {
  return kind === "exited"
    ? "it exited as it started, without a word. A realtime build from before /health/ready exits like this on a Postgres without logical decoding; `supatype update` fetches a current one."
    : `nothing answered at ${url}/health/ready within ${Math.round(timeoutMs / 1000)}s.`
}

/** Record and say that realtime is serving, and how much of it. */
function announceRealtime(opts: NativeRealtimeOptions, state: RealtimeState): void {
  // Enabled in every case here: the socket answers, so broadcast and presence work whatever the
  // database can do, and the gateway's own health probe asks only whether it is up.
  patchRouteManifest(opts.manifestPath, { realtime_enabled: true, realtime_url: opts.url })
  if (state.kind === "unsupported") {
    console.warn(
      `[supatype] ⚠  Realtime is up at ${opts.url} for broadcast and presence, but database changes are off: ` +
        `${state.reason}. Run \`supatype db check\` for the remedy.`,
    )
    return
  }
  const connecting = state.kind === "connecting" ? " (still connecting to the database)" : ""
  console.log(`[supatype] Realtime service: ${opts.url}${connecting}`)
}

/** Record that realtime is not running, say why, and answer null for the caller to hold. */
function realtimeNotRunning(opts: NativeRealtimeOptions, why: string): null {
  disableRealtime(opts.manifestPath, `Realtime is not running: ${why}\n `)
  return null
}

/** Switch realtime off in the manifest and say so, `headline` first. */
function disableRealtime(manifestPath: string, headline: string): void {
  patchRouteManifest(manifestPath, { realtime_enabled: false, realtime_url: undefined })
  console.warn(
    `[supatype] ⚠  ${headline} The gateway answers realtime requests with "realtime disabled", ` +
      "and WebSocket subscriptions will not work.",
  )
}
