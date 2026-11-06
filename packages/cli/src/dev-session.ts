/**
 * `supatype dev` output session, Ink dashboard (default) or interleaved stream mode.
 */

import { render, type Instance, type RenderOptions } from "ink"
import { AsyncLocalStorage } from "node:async_hooks"
import { setTimeout as sleep } from "node:timers/promises"
import { prepareStdinForInk } from "./ui/runtime/stdin-after-ink.js"
import React from "react"
import type { ProcessOptions } from "./process-manager.js"
import { filterCommandLogLine, filterDevSubprocessLine, filterStackLogLine, formatConsoleArgs } from "./dev-log-filter.js"
import { DevLogBus, type DevLogLevel } from "./dev-log-bus.js"
import { DevDashboard } from "./ui/dev/DevDashboard.js"
import { ensureDevShutdownHooks } from "./dev-shutdown.js"
import { clearDevPromptQueue } from "./ui/runtime/dev-prompt-queue.js"

export type DevUiMode = "tui" | "stream"

export function resolveDevUiMode(streamFlag: boolean): DevUiMode {
  if (streamFlag) return "stream"
  if (!process.stdout.isTTY || !process.stdin.isTTY) return "stream"
  return "tui"
}

let activeSession: DevSession | null = null

export function beginDevSession(mode: DevUiMode): DevSession {
  ensureDevShutdownHooks()
  activeSession?.stop()
  activeSession = new DevSession(mode)
  if (activeSession.isTui()) {
    activeSession.enableConsoleCapture(false)
    activeSession.startInk()
  }
  return activeSession
}

/** How long Ink may hold a redraw back: it draws at most once in this window. */
const INK_FRAME_MS = 40

/**
 * Names what dev is waiting on, shown on the dashboard with a spinner until the next step or the
 * ready panel, then pauses for Ink to draw it. Much of a native start blocks the thread (initdb,
 * starting Postgres, the schema push), and a step set just before one of those was never drawn: the
 * dashboard went from the logo straight to the services. The log line each step already prints
 * stays as it was; in stream mode that line is all there is.
 */
export async function showDevStep(step: string): Promise<void> {
  activeSession?.bus.setStep(step)
  if (activeSession?.isInkMounted() === true) await sleep(INK_FRAME_MS)
}

/** @deprecated Ink starts in beginDevSession, kept for callers that invoke late. */
export function startDevSession(): void {
  activeSession?.startInk()
}

export function isDevTuiActive(): boolean {
  return activeSession?.isInkMounted() ?? false
}

export function endDevSession(): void {
  clearDevPromptQueue()
  activeSession?.stop()
  activeSession = null
}

/** @deprecated Dev prompts render inside the Ink dashboard, no suspend needed. */
export function suspendDevSessionForPrompt(): void {
  prepareStdinForInteractivePrompt()
}

export function prepareStdinForInteractivePrompt(): void {
  if (!process.stdin.isTTY) return
  process.stdin.setRawMode(false)
  process.stdin.resume()
}

/** @deprecated Dev prompts render inside the Ink dashboard, no resume needed. */
export function resumeDevSessionAfterPrompt(): void {
  // no-op: prompts are Ink overlays
}

/** @deprecated Use Ink overlay prompts, runs fn without tearing down the dashboard. */
export async function withDevSessionSuspended<T>(fn: () => Promise<T>): Promise<T> {
  return fn()
}

export function getActiveDevSession(): DevSession | null {
  return activeSession
}

export function appendStackOutput(
  text: string | null | undefined,
  level: DevLogLevel = "log",
): void {
  if (text == null || text.trim() === "") return
  const session = getActiveDevSession()
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue
    if (session?.isTui() && !filterStackLogLine(line)) continue
    if (session?.isConsoleCaptured()) {
      session.bus.append("stack", line, level)
      continue
    }
    const write = level === "warn" ? console.warn : level === "error" ? console.error : console.log
    write(`[supatype] ${line}`)
  }
}

export function appendDevTaskLog(
  taskId: string,
  taskTitle: string,
  line: string,
  level: DevLogLevel = "log",
): void {
  const session = getActiveDevSession()
  if (session?.isTui()) {
    session.bus.ensureTask(taskId, taskTitle)
    session.bus.append(taskId, line, level)
    return
  }
  const prefix = taskId === "stack" ? "[supatype]" : `[${taskId}]`
  const write = level === "warn" ? console.warn : level === "error" ? console.error : console.log
  write(`${prefix} ${line}`)
}

/** Set while a push a save set off runs, for every line it logs however deep in it. */
const savePushScope = new AsyncLocalStorage<true>()

/**
 * Runs the push a save set off, with what it logs shown on the supatype pane as `--stream` prints
 * it. The pane keeps only the lines of dev's own it knows, and the access lines a save changed (and
 * the push's warnings and hints) are none of those, so they were dropped. Inside this only Docker's
 * progress is dropped, as a command's log is filtered.
 */
export function withSavePushOutput<T>(push: () => Promise<T>): Promise<T> {
  return savePushScope.run(true, push)
}

/**
 * The dashboard, mounted. Ctrl+C is the dashboard's to handle: it starts dev's shutdown. Left to
 * Ink, the first Ctrl+C unmounted the dashboard and nothing else, so dev kept running with no screen
 * until a second one reached it as a signal.
 *
 * The console is the session's (enableConsoleCapture), not Ink's. Ink's own patch, taken as it
 * mounted, replaced the session's: every line dev logged after that was written past the pane, so
 * the supatype pane stayed at "Services running." through every save.
 */
export function renderDevDashboard(bus: DevLogBus, streams: Pick<RenderOptions, "stdin" | "stdout"> = {}): Instance {
  return render(React.createElement(DevDashboard, { bus }), { ...streams, patchConsole: false, exitOnCtrlC: false })
}

export class DevSession {
  readonly bus = new DevLogBus()
  readonly mode: DevUiMode
  private ink: Instance | null = null
  private restoreConsole: (() => void) | null = null
  private consoleCaptured = false

  constructor(mode: DevUiMode) {
    this.mode = mode
  }

  isTui(): boolean {
    return this.mode === "tui"
  }

  isInkMounted(): boolean {
    return this.ink !== null
  }

  isConsoleCaptured(): boolean {
    return this.consoleCaptured
  }

  needsPromptSuspend(): boolean {
    return false
  }

  enableConsoleCapture(_tee: boolean): void {
    if (!this.isTui() || this.consoleCaptured) return
    this.restoreConsole = patchConsole(this.bus)
    this.consoleCaptured = true
  }

  startInk(streams: Pick<RenderOptions, "stdin" | "stdout"> = {}): void {
    if (!this.isTui() || this.ink) return
    // A prompt before dev started stopped stdin's read when it ended; the dashboard needs it.
    prepareStdinForInk()
    this.ink = renderDevDashboard(this.bus, streams)
  }

  stop(): void {
    this.ink?.unmount()
    this.ink = null
    if (this.restoreConsole) {
      this.restoreConsole()
      this.restoreConsole = null
      this.consoleCaptured = false
    }
  }
}

export function enhanceProcessOptions(label: string, opts: ProcessOptions): ProcessOptions {
  const session = getActiveDevSession()
  const subprocessFilter =
    label === "app" || label === "studio"
      ? { shouldLogLine: (line: string) => filterDevSubprocessLine(label, line) }
      : {}

  if (!session?.isTui()) {
    return { ...opts, ...subprocessFilter }
  }

  session.bus.ensureTask(label, label)
  return {
    ...opts,
    ...subprocessFilter,
    onLine: (line, stream) => {
      session.bus.append(label, line, stream === "stderr" ? "error" : "log")
    },
  }
}

function appendFilteredStackLine(bus: DevLogBus, line: string, level: DevLogLevel): void {
  const keep = savePushScope.getStore() === true ? filterCommandLogLine : filterStackLogLine
  for (const part of line.split(/\r?\n/)) {
    if (!part.trim()) continue
    if (!keep(part)) continue
    bus.append("stack", part, level)
  }
}

function patchConsole(bus: DevLogBus): () => void {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  }

  console.log = (...args: unknown[]) => {
    appendFilteredStackLine(bus, formatConsoleArgs(args), "log")
  }
  console.warn = (...args: unknown[]) => {
    appendFilteredStackLine(bus, formatConsoleArgs(args), "warn")
  }
  console.error = (...args: unknown[]) => {
    appendFilteredStackLine(bus, formatConsoleArgs(args), "error")
  }

  return () => {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
}
