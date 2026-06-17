/**
 * Line filters for subprocess output during `supatype dev`.
 */

/** Strip ANSI SGR sequences for TUI rendering. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "")
}

/** Drop npm/vite noise from frontend dev servers (proxy app + Studio). */
export function filterDevSubprocessLine(taskId: string, line: string): boolean {
  if (taskId !== "app" && taskId !== "studio") return true
  const trimmed = stripAnsi(line).trim()
  if (!trimmed) return false
  if (/^>\s+\S/.test(trimmed)) return false
  if (trimmed.includes("Network:") && trimmed.includes("➜")) return false
  return true
}

/** Format console.* arguments the way Node does for a single log line. */
export function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(" ")
}
