/**
 * `supatype dev` output session — TUI (default) or interleaved stream mode.
 */

import type { ProcessOptions } from "./process-manager.js"
import { filterDevSubprocessLine, formatConsoleArgs } from "./dev-log-filter.js"
import { DevLogBus, type DevLogLevel } from "./dev-log-bus.js"
import { DevTui } from "./dev-tui.js"

export type DevUiMode = "tui" | "stream"

export function resolveDevUiMode(streamFlag: boolean): DevUiMode {
  if (streamFlag) return "stream"
  if (!process.stdout.isTTY || !process.stdin.isTTY) return "stream"
  return "tui"
}

let activeSession: DevSession | null = null

export function beginDevSession(mode: DevUiMode): DevSession {
  activeSession?.stop()
  activeSession = new DevSession(mode)
  return activeSession
}

/** Enter console capture + TUI. */
export function startDevSession(): void {
  activeSession?.start()
}

export function endDevSession(): void {
  activeSession?.stop()
  activeSession = null
}

export function getActiveDevSession(): DevSession | null {
  return activeSession
}

/** Log to a TUI task stream, or prefixed console output in stream mode. */
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

export class DevSession {
  readonly bus = new DevLogBus()
  readonly mode: DevUiMode
  private tui: DevTui | null = null
  private restoreConsole: (() => void) | null = null

  constructor(mode: DevUiMode) {
    this.mode = mode
  }

  isTui(): boolean {
    return this.mode === "tui"
  }

  start(): void {
    if (!this.isTui()) return
    this.restoreConsole = patchConsole(this.bus)
    this.tui = new DevTui(this.bus)
    this.tui.start()
  }

  stop(): void {
    this.tui?.stop()
    this.tui = null
    this.restoreConsole?.()
    this.restoreConsole = null
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

function patchConsole(bus: DevLogBus): () => void {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  }

  console.log = (...args: unknown[]) => {
    bus.append("stack", formatConsoleArgs(args), "log")
  }
  console.warn = (...args: unknown[]) => {
    bus.append("stack", formatConsoleArgs(args), "warn")
  }
  console.error = (...args: unknown[]) => {
    bus.append("stack", formatConsoleArgs(args), "error")
  }

  return () => {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
}
