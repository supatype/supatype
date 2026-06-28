/**
 * Branded Ink chrome for one-shot CLI commands (push, diff, adopt, …).
 * Reuses the flow shell: figlet logo, coloured log pane, ink-spinner, prompts.
 */

import type { Command } from "commander"
import type { ClackApi } from "../clack-api.js"
import { getActiveFlowApi } from "./flow-session.js"
import { runClackFlow } from "../clack.js"
import { isInteractive } from "../interactive.js"
import {
  filterCommandLogLine,
  formatConsoleArgs,
  stripAnsi,
} from "../../dev-log-filter.js"

function patchConsoleForCommand(api: ClackApi): () => void {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  }

  const emitLine = (raw: string, stream: "log" | "warn" | "error"): void => {
    if (!filterCommandLogLine(raw)) return
    const t = stripAnsi(raw).trim()
    if (!t) return
    const stripped = t.replace(/^\[supatype\]\s*/, "")

    if (stream === "error" || stripped.startsWith("✗")) {
      api.log.error(stripped.replace(/^✗\s*/, ""))
      return
    }
    if (stream === "warn" || stripped.startsWith("⚠")) {
      api.log.warn(stripped.replace(/^⚠\s*/, ""))
      return
    }
    if (stripped.startsWith("✓")) {
      api.log.success(stripped.replace(/^✓\s*/, ""))
      return
    }
    if (/\[supatype\]/.test(raw)) {
      api.log.info(stripped)
      return
    }
    api.note(t)
  }

  const wrap =
    (stream: "log" | "warn" | "error") =>
    (...args: unknown[]): void => {
      for (const part of formatConsoleArgs(args).split(/\r?\n/)) {
        emitLine(part, stream)
      }
    }

  console.log = wrap("log")
  console.warn = wrap("warn")
  console.error = wrap("error")

  return () => {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
}

/**
 * Run a command body inside the branded Ink shell (logo + logs + spinner).
 * Falls back to plain stdout when not interactive.
 */
export async function runCommandChrome<T>(fn: () => Promise<T>): Promise<T> {
  if (!isInteractive() || isCommandChromeActive()) {
    return fn()
  }

  return runClackFlow(async (api) => {
    const restore = patchConsoleForCommand(api)
    try {
      return await fn()
    } finally {
      restore()
    }
  })
}

/** True while `runCommandChrome` / `runClackFlow` is active. */
export function isCommandChromeActive(): boolean {
  return getActiveFlowApi() !== null
}

/** Commands that mount their own Ink UI — do not wrap with command chrome. */
const WIZARD_COMMAND_PATHS = new Set(["dev", "init", "link"])

/** Prefixes for subcommands that call `runClackFlow` internally. */
const WIZARD_COMMAND_PREFIXES = ["add "]

/** Long-running or stdio-inherit commands where chrome would fight subprocess output. */
const STREAMING_COMMAND_PATHS = new Set([
  "logs",
  "pg psql",
  "functions serve",
  "self-host compose logs",
])

type CommandWithAction = Command & {
  parent?: Command | null
  _actionHandler?: ((args: unknown) => unknown) | null
}

/** Whether a registered command path should skip automatic command chrome. */
export function shouldExcludeCommandChrome(commandPath: string): boolean {
  if (WIZARD_COMMAND_PATHS.has(commandPath)) return true
  if (WIZARD_COMMAND_PREFIXES.some((prefix) => commandPath.startsWith(prefix))) return true
  if (STREAMING_COMMAND_PATHS.has(commandPath)) return true
  return false
}

function commandPath(cmd: CommandWithAction, root: Command): string {
  const segments: string[] = []
  let current: CommandWithAction | null = cmd
  while (current && current !== root) {
    segments.unshift(current.name())
    current = current.parent ?? null
  }
  return segments.join(" ")
}

function wrapCommandAction(cmd: CommandWithAction, root: Command): void {
  const path = commandPath(cmd, root)
  const handler = cmd._actionHandler
  if (!handler || shouldExcludeCommandChrome(path)) return

  cmd._actionHandler = (args: unknown) =>
    runCommandChrome(() => Promise.resolve(handler(args)))
}

/** Wrap every leaf command action with branded Ink chrome (see exclusions above). */
export function wrapProgramActionsWithChrome(program: Command): void {
  const walk = (cmd: CommandWithAction): void => {
    wrapCommandAction(cmd, program)
    for (const sub of cmd.commands) {
      walk(sub as CommandWithAction)
    }
  }
  walk(program as CommandWithAction)
}
