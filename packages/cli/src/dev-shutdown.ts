/**
 * Graceful shutdown for `supatype dev`, SIGINT, TUI Ctrl+C, terminal close, the process that
 * started it exiting, and a synchronous compose-down fallback on process exit.
 */

import { existsSync } from "node:fs"
import { errorMessage } from "./error-message.js"
import { endDevSession } from "./dev-session.js"
import { clearDevSessionLock } from "./dev-session-lock.js"
import { runDockerCompose } from "./self-host-compose.js"
import { watchParent, windowsParentOf, type ParentWatch } from "./parent-watch.js"
import { STOP_SIGNALS } from "./stop-signals.js"

export interface DevComposeShutdownFallback {
  cwd: string
  composePath: string
  composeProject: string
}

let shutdownWork: (() => Promise<void>) | null = null
/** Whether `shutdownWork` was registered as the start began, and the start has not finished yet. */
let startRunning = false
/** An undo of something dev's start began. */
type StartUndo = () => void | Promise<void>
/** The services dev's start began, undone together by an interrupted start or by the shutdown. */
const serviceUndo: StartUndo[] = []
/** What the services use (native Postgres), undone after them, last first. */
const lastUndo: StartUndo[] = []
/**
 * Docker containers dev's start began (native dev's Valkey sidecar): undone beside everything else,
 * since nothing else waits for them, and named if a forced quit leaves them running.
 */
const containerUndo: StartUndo[] = []
const containersStarted: string[] = []
/** Undos recorded once the shutdown had begun: run at once, and waited for before the process ends. */
const lateUndo: Array<Promise<unknown>> = []
let composeFallback: DevComposeShutdownFallback | null = null
let shutdownCwd: string | null = null
let shuttingDown = false
let shutdownCompleted = false
let forceQuitRequested = false
let hooksRegistered = false
let ignoreSigintUntil = 0
let parentWatch: ParentWatch | null = null

/**
 * Stops `dev` once the process that started it is gone (parent-watch.ts). A script killed
 * outright runs no cleanup, so this is the only thing left that can stop the stack.
 */
function watchForOrphaning(): void {
  parentWatch = watchParent(() => {
    process.stderr.write(
      "\n[supatype] The process that started `supatype dev` has exited, so dev is stopping its stack.\n" +
        "[supatype] To leave a stack running with nothing attached, use `supatype self-host compose up -d`.\n",
    )
    void runDevShutdown()
  })
  if (process.platform === "win32") {
    const watch = parentWatch
    void windowsParentOf(process.ppid).then((grandparent) => {
      if (grandparent !== undefined) watch.watchAlso(grandparent)
    })
  }
}

/** SIGINT/SIGTERM/SIGHUP hooks: call as soon as `supatype dev` starts (before compose is up). */
export function ensureDevShutdownHooks(): void {
  if (hooksRegistered) return
  hooksRegistered = true

  // SIGHUP included: a closed terminal, unheard, killed dev with no shutdown and left the whole
  // stack running (C5).
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal)
  process.on("exit", onProcessExit)
  watchForOrphaning()

  if (process.stdin.isTTY) {
    process.stdin.on("end", onStdinClose)
    process.stdin.on("close", onStdinClose)
  }
}

/**
 * Two of the same signal this close together are one. Run from npm, dev's starter passes on a
 * Ctrl+C the terminal also sent dev, so one press arrives twice, milliseconds apart; counted as two,
 * the second forced the quit. A person pressing again to force quit takes longer than this.
 */
const REPEATED_SIGNAL_MS = 500
let lastSignal: { signal: NodeJS.Signals; at: number } | null = null

function onSignal(signal: NodeJS.Signals): void {
  const now = Date.now()
  if (now < ignoreSigintUntil) return
  const repeat = lastSignal !== null && lastSignal.signal === signal && now - lastSignal.at < REPEATED_SIGNAL_MS
  lastSignal = { signal, at: now }
  if (repeat) return
  void runDevShutdown()
}

function onStdinClose(): void {
  if (!process.stdin.isTTY) return
  void runDevShutdown()
}

function syncComposeDownFallback(): void {
  if (shutdownCompleted || !composeFallback) return
  try {
    runDockerCompose(
      composeFallback.composePath,
      ["down"],
      composeFallback.cwd,
      composeFallback.composeProject,
      // As the shutdown's own `down`: a slow daemon probe here said Docker was down and called
      // process.exit from inside the exit hook.
      { quiet: true, skipDaemonProbe: true },
    )
  } catch {
    // best-effort: process is exiting
  }
  if (shutdownCwd) clearDevSessionLock(shutdownCwd)
}

function onProcessExit(): void {
  syncComposeDownFallback()
}

export interface RegisterDevShutdownOptions {
  /** Sync `docker compose down` when async teardown cannot finish (terminal close, kill). */
  compose?: DevComposeShutdownFallback
  /** Project root: clears `.supatype/dev-session.json` after shutdown. */
  cwd?: string
  /**
   * Registered as the start begins (Docker dev, whose stack has to come down however it ends): until
   * {@link waitForDevShutdown}, a Ctrl+C runs `work` as a stopped start, `Stopped during start.` and
   * exit 130, as native dev's does. It ran as a running dev's shutdown, exit 0 (0.9.1 release test, FF11).
   */
  duringStart?: boolean
}

/** Register async teardown (stop children, compose down, etc.). Call once per dev session. */
export function registerDevShutdown(
  work: () => Promise<void>,
  opts?: RegisterDevShutdownOptions,
): void {
  shutdownWork = work
  startRunning = opts?.duringStart === true
  composeFallback = opts?.compose ?? null
  shutdownCwd = opts?.cwd ?? opts?.compose?.cwd ?? null
  ensureDevShutdownHooks()
}

/**
 * Records the undo of a service dev's start has just spawned (realtime, storage, the server, the
 * Valkey container), the moment it is spawned, before it reports ready. An interrupted start undoes
 * them all, and so does the shutdown dev registers once it is up, after its own work.
 */
export function pushStartUndo(undo: StartUndo, opts: { container?: string } = {}): void {
  if (opts.container !== undefined) containersStarted.push(opts.container)
  if (shuttingDown) return runLate(undo)
  ;(opts.container !== undefined ? containerUndo : serviceUndo).push(undo)
  ensureDevShutdownHooks()
}

/**
 * Records the undo of what the services use, native Postgres, the moment it starts: undone after
 * every service has stopped. Ctrl+C during the auth migrations left Postgres running.
 */
export function pushStartUndoLast(undo: StartUndo): void {
  if (shuttingDown) return runLate(undo)
  lastUndo.push(undo)
  ensureDevShutdownHooks()
}

/**
 * An undo recorded after the shutdown began, while the start was still running: the lists may
 * already be emptied, so it runs now, and the drain waits for it.
 */
function runLate(undo: StartUndo): void {
  lateUndo.push(Promise.resolve().then(undo).then(() => undefined, (err: unknown) => err))
}

/**
 * Never settles once the shutdown has begun, so a start still running stops before it begins
 * anything more; the shutdown ends the process. Called between dev's start steps.
 */
export async function haltIfStopping(): Promise<void> {
  if (shuttingDown) await new Promise<never>(() => undefined)
}

/**
 * `work`, and under SUPATYPE_DEBUG=1 how long it took, so where a shutdown's time goes can be read
 * from a run rather than guessed (round 6b, C10).
 */
async function timed<T>(phase: string, work: () => Promise<T>): Promise<T> {
  if (process.env["SUPATYPE_DEBUG"] !== "1") return work()
  const start = Date.now()
  try {
    return await work()
  } finally {
    process.stderr.write(`[supatype] shutdown: ${phase} took ${Date.now() - start} ms\n`)
  }
}

/** Runs `undos` together; the errors of those that failed. */
async function undoTogether(undos: StartUndo[]): Promise<unknown[]> {
  const settled = await Promise.allSettled(undos.map((undo) => Promise.resolve().then(undo)))
  return settled.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []))
}

/** The services' undos together, then what they use one at a time, last first. */
async function undoServicesThenLast(): Promise<unknown[]> {
  const errors = await timed("services", () => undoTogether(serviceUndo.splice(0)))
  await timed("Postgres and what else the services use", async () => {
    for (let undo = lastUndo.pop(); undo !== undefined; undo = lastUndo.pop()) {
      await Promise.resolve().then(undo).catch((err: unknown) => errors.push(err))
    }
  })
  return errors
}

/**
 * Runs every recorded undo: the services' together, then the rest one at a time, last first, with
 * the containers' beside them all (a `docker rm -f` is about a second on Docker Desktop, and
 * Postgres's stop waited for it). Returns the errors of those that failed; a failed one stops
 * nothing after it.
 */
export async function drainStartUndo(): Promise<unknown[]> {
  const [chain, containers] = await Promise.all([undoServicesThenLast(), timed("containers", () => undoTogether(containerUndo.splice(0)))])
  const errors = [...chain, ...containers]
  while (lateUndo.length > 0) {
    for (const failed of await Promise.all(lateUndo.splice(0))) if (failed !== undefined) errors.push(failed)
  }
  return errors
}

/**
 * Keep `supatype dev` running until a signal (or the TUI) shuts it down. Never resolves.
 *
 * A pending promise is not something Node waits for. `dev` used to end on
 * `await new Promise(() => undefined)`, which held the process only while something else did: a
 * schema watcher, a child app, the TUI reading stdin. `dev --stream --no-watch` with stdin not a
 * terminal has none of them, so the event loop drained the moment the ready banner printed, the
 * process exited 0, and the `exit` hook above ran a silent `docker compose down`. The stack
 * reported ready and was gone a second later, with nothing in the output saying why.
 *
 * The interval is the handle that keeps the loop alive. Shutdown leaves through `process.exit`,
 * so it never needs clearing. Called once the start is done, so from here a Ctrl+C is a running
 * dev's shutdown.
 */
export function waitForDevShutdown(): Promise<never> {
  startRunning = false
  setInterval(() => undefined, 0x7fffffff)
  return new Promise<never>(() => undefined)
}

/** TUI Ctrl+C: do not re-emit SIGINT (avoids double-fire on Windows raw mode). */
export function requestDevShutdown(): void {
  ignoreSigintUntil = Date.now() + 400
  void runDevShutdown()
}

/** How long a failed start step waits for a Ctrl+C that reached its child too. */
const INTERRUPT_SETTLE_MS = 250

/**
 * `action`, ending quietly when it failed because of a Ctrl+C. Ctrl+C reaches a start step's child
 * (pg_ctl, the server's migrations) as well, which then fails, and the signal reaches this process
 * just after. So when the action fails, this waits a moment, and when a shutdown began, never
 * settles: the shutdown ends the process with one line, and the child's failure is not reported.
 * A failure for any other reason undoes what the start began, then is reported: it left Postgres
 * and the services running.
 */
export function stopQuietlyDuringStart<A extends unknown[]>(
  action: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args) => {
    try {
      await action(...args)
    } catch (err) {
      await haltIfInterrupted()
      await drainStartUndo()
      throw err
    }
  }
}

/** Waits for a Ctrl+C that may be on its way after a child failed, and never settles if one came. */
async function haltIfInterrupted(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, INTERRUPT_SETTLE_MS))
  await haltIfStopping()
}

/**
 * `report`, said only when no shutdown began. A push the Ctrl+C also reached fails, and dev catches
 * that failure itself, so `stopQuietlyDuringStart` never sees it: without this, its message came
 * before `Stopped during start.`.
 */
export function reportUnlessStopping(report: (err: unknown) => void): (err: unknown) => Promise<void> {
  return async (err) => {
    await haltIfInterrupted()
    report(err)
  }
}

export function isDevShuttingDown(): boolean {
  return shuttingDown
}

/** Whether dev's own Ctrl+C handling is in place (ensureDevShutdownHooks), so a Ctrl+C is dev's to take. */
export function devShutdownHooksRegistered(): boolean {
  return hooksRegistered
}

/** @internal Tests: reset module state between cases. */
export function resetDevShutdownForTests(): void {
  shutdownWork = null
  startRunning = false
  serviceUndo.length = 0
  lastUndo.length = 0
  containerUndo.length = 0
  containersStarted.length = 0
  lateUndo.length = 0
  composeFallback = null
  shutdownCwd = null
  shuttingDown = false
  shutdownCompleted = false
  forceQuitRequested = false
  hooksRegistered = false
  ignoreSigintUntil = 0
  lastSignal = null
  parentWatch?.stop()
  parentWatch = null
}

/**
 * Ctrl+C while dev was still starting. Undoes what the start began (pushStartUndo,
 * pushStartUndoLast), says so in one line, and exits 130. A failed undo is not reported over that
 * line: there is nothing more to do about it here. Work registered as the start began (Docker dev's
 * compose stack) runs first, and its failure is reported as a failed shutdown's is.
 */
async function stopDuringStart(work: (() => Promise<void>) | null): Promise<never> {
  process.stderr.write("\n[supatype] Stopped during start.\n")
  if (work === null) await drainStartUndo()
  else await runShutdownWork(work)
  shutdownCompleted = true
  if (shutdownCwd) clearDevSessionLock(shutdownCwd)
  process.exit(130)
}

/** The registered work, then what the start began, last first; throws the first failure. */
async function runShutdownWork(work: () => Promise<void>): Promise<void> {
  const failed = await Promise.resolve().then(work).then(() => [], (err: unknown) => [err])
  const [first] = [...failed, ...(await drainStartUndo())]
  if (first !== undefined) throw first
}

/**
 * What a forced quit may leave running: the compose stack's containers, or the containers native
 * dev started; undefined when there are none, and a forced quit leaves nothing behind.
 */
function leftByForcedQuit(): string | undefined {
  if (composeFallback !== null) return "Docker containers"
  return containersStarted.length > 0 ? containersStarted.join(", ") : undefined
}

/**
 * A Ctrl+C while the shutdown runs. Where containers could be left running, the first one only says
 * so and the next forces the exit; with none (native dev without a Valkey sidecar) it forces the
 * exit at once (round 6b, C10).
 */
function interruptShutdown(): void {
  const left = leftByForcedQuit()
  if (left !== undefined && !forceQuitRequested) {
    forceQuitRequested = true
    process.stderr.write("\n[supatype] Still shutting down… press Ctrl+C again to force quit.\n")
    return
  }
  try {
    endDevSession()
  } catch {
    // best-effort terminal restore
  }
  process.stderr.write(left === undefined ? "\n[supatype] Forced quit.\n" : `\n[supatype] Forced quit: ${left} may still be running.\n`)
  process.stdout.write("\n")
  process.exit(130)
}

async function runDevShutdown(): Promise<void> {
  if (shuttingDown) return interruptShutdown()
  shuttingDown = true

  try {
    endDevSession()
    if (shutdownWork === null || startRunning) return await stopDuringStart(shutdownWork)
    process.stderr.write("\n[supatype] Shutting down…\n")
    await runShutdownWork(shutdownWork)
    shutdownCompleted = true
    if (shutdownCwd) clearDevSessionLock(shutdownCwd)
    process.exit(0)
  } catch (err) {
    process.stderr.write(`[supatype] Shutdown failed: ${errorMessage(err)}\n`)
    if (composeFallback !== null) {
      process.stderr.write("[supatype] Docker containers may still be running, try: supatype self-host compose down\n")
    }
    syncComposeDownFallback()
    shutdownCompleted = true
    process.exit(1)
  }
}

/** Whether a compose fallback was registered (tests). */
export function hasComposeShutdownFallback(): boolean {
  return composeFallback !== null && existsSync(composeFallback.composePath)
}
