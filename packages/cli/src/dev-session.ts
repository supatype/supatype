/**
 * `supatype dev` output session — Ink dashboard (default) or interleaved stream mode.
 */

import { render, type Instance } from "ink"
import React from "react"
import type { ProcessOptions } from "./process-manager.js"
import { filterDevSubprocessLine, filterStackLogLine, formatConsoleArgs } from "./dev-log-filter.js"
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

/** @deprecated Ink starts in beginDevSession — kept for callers that invoke late. */
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

/** @deprecated Dev prompts render inside the Ink dashboard — no suspend needed. */
export function suspendDevSessionForPrompt(): void {
  prepareStdinForInteractivePrompt()
}

export function prepareStdinForInteractivePrompt(): void {
  if (!process.stdin.isTTY) return
  process.stdin.setRawMode(false)
  process.stdin.resume()
}

/** @deprecated Dev prompts render inside the Ink dashboard — no resume needed. */
export function resumeDevSessionAfterPrompt(): void {
  // no-op — prompts are Ink overlays
}

/** @deprecated Use Ink overlay prompts — runs fn without tearing down the dashboard. */
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

  startInk(): void {
    if (!this.isTui() || this.ink) return
    this.ink = render(React.createElement(DevDashboard, { bus: this.bus }))
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
  for (const part of line.split(/\r?\n/)) {
    if (!part.trim()) continue
    if (!filterStackLogLine(part)) continue
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
