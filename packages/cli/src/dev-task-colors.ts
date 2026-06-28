/**
 * ANSI colours for `supatype dev` TUI task list and log panes.
 */

import { BOLD, DIM, RESET } from "./ui/brand.js"

export { RESET, DIM, BOLD }

/** Purple for orchestrator logs, green for Vite/app, etc. */
export function taskColor(taskId: string): string {
  switch (taskId) {
    case "stack":
      return "\x1b[35m"
    case "app":
      return "\x1b[32m"
    case "studio":
      return "\x1b[96m"
    case "server":
      return "\x1b[32m"
    case "postgrest":
      return "\x1b[36m"
    default:
      return "\x1b[37m"
  }
}

export function levelColor(line: string): string | null {
  if (line.startsWith("✗ ")) return "\x1b[31m"
  if (line.startsWith("⚠ ")) return "\x1b[33m"
  return null
}

/** Drop redundant prefix — task pane is already labelled supatype. */
export function normalizeStackLogLine(line: string): string {
  return line.replace(/^\[supatype\]\s*/, "")
}

export function colorizeLogLine(taskId: string, line: string): string {
  const level = levelColor(line)
  const base = level ?? taskColor(taskId)
  return `${base}${line}${RESET}`
}

/** Ink colour names for React components (parallel to ANSI taskColor). */
export function taskInkColor(taskId: string): string {
  switch (taskId) {
    case "stack":
      return "magenta"
    case "app":
      return "green"
    case "studio":
      return "cyan"
    case "server":
      return "green"
    case "postgrest":
      return "blue"
    default:
      return "white"
  }
}

export function logInkColor(taskId: string, line: string): string {
  if (line.startsWith("✗ ")) return "red"
  if (line.startsWith("⚠ ")) return "yellow"
  return taskInkColor(taskId)
}
