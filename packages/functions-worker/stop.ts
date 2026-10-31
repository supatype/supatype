/**
 * The worker stops when it is told to. In its container it runs as PID 1, and PID 1 gets no default
 * action for SIGTERM or SIGINT: with no handler, `docker restart` and `docker stop` waited out the
 * whole stop timeout (10 s) before killing it, so every self-host deploy that restarted the worker
 * took more than ten seconds. The compose file also gives it an init (`init: true`).
 *
 * On SIGTERM it does not exit mid-request: a deploy restarts the worker, and exiting at once cut off
 * every invocation in flight. It stops taking requests, lets those it has finish, then exits; bounded
 * by {@link drainGraceMs}. SIGINT (Ctrl+C in dev or `functions serve`) and a second signal while
 * draining exit at once: someone at a terminal is not kept waiting.
 */

/**
 * How long in-flight requests get to finish when nothing says otherwise: under the 5 s the dev
 * process manager waits before it kills the worker, so a stop in dev is never slower than a kill.
 */
export const DRAIN_GRACE_MS = 4_000

/** The longest drain the environment may ask for; more would outlast any stop timeout in use. */
export const MAX_DRAIN_GRACE_MS = 60_000

/**
 * The drain grace `SUPATYPE_FUNCTIONS_DRAIN_MS` asks for, in whole milliseconds, capped at
 * {@link MAX_DRAIN_GRACE_MS}; {@link DRAIN_GRACE_MS} when it is unset or not a whole number. The
 * self-host compose sets it under its stop_grace_period: there Docker allows 10 s, and a 4 s drain
 * cut off every function with more left at each restart (round 6b, N29).
 */
export function drainGraceMs(value: string | undefined): number {
  const text = value?.trim() ?? ""
  if (!/^\d+$/.test(text)) return DRAIN_GRACE_MS
  return Math.min(Number(text), MAX_DRAIN_GRACE_MS)
}

/** What stopping needs of Deno, replaceable in tests. */
export interface StopHooks {
  os: string
  addSignalListener(signal: "SIGTERM" | "SIGINT", handler: () => void): void
  exit(code: number): void
}

const DENO_HOOKS: StopHooks = {
  os: Deno.build.os,
  addSignalListener: (signal, handler) => Deno.addSignalListener(signal, handler),
  exit: (code) => Deno.exit(code),
}

/** `drain()`, or `graceMs`, whichever ends first; the timer is cleared either way. */
async function drainWithin(drain: () => Promise<void>, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const grace = new Promise<void>((done) => (timer = setTimeout(done, graceMs)))
  try {
    await Promise.race([drain().catch(() => undefined), grace])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * On SIGTERM, drains with `drain` (closing the log tails and the server's `shutdown()`, which stops
 * taking requests and resolves once those in flight have finished) for at most `graceMs`, then exits
 * 0. SIGINT, and any signal while draining, exits at once. Not on Windows, where Deno takes no SIGTERM
 * listener and a process is stopped some other way.
 */
export function exitOnStop(
  drain: () => Promise<void>,
  hooks: StopHooks = DENO_HOOKS,
  graceMs = drainGraceMs(Deno.env.get("SUPATYPE_FUNCTIONS_DRAIN_MS")),
): void {
  if (hooks.os === "windows") return
  let draining = false
  const exitNow = (): void => hooks.exit(0)
  hooks.addSignalListener("SIGINT", exitNow)
  hooks.addSignalListener("SIGTERM", () => {
    if (draining) return exitNow()
    draining = true
    void drainWithin(drain, graceMs).then(exitNow)
  })
}
