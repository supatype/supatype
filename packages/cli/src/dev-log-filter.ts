/**
 * Line filters for subprocess output during `supatype dev`.
 */

import { isComposeProgressLine } from "./engine-push-output.js"

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

const DOCKER_BUILD_NOISE =
  /^#\d+\s|^#\d+ \[|^\s*=> \[|^\s*=>\s|^\s*--->\s|^\s*\d+\.\d+s\s|^\s*CACHED\s|^\s*DONE\s[\d.]+s?$|^Step \d+\/\d+|^Successfully (built|tagged)|^WARNING:|^DEPRECATED:|^View build details:|^What's next:|^The push refers to|^Using docker|^Sending build context|^Pulling fs layer|^Waiting$|^Verifying Checksum|^Download complete|^Pull complete|^Extracting \[|^Already exists$|^Building dependency tree|^Reading state information|^Get:\d+ |^Fetched \d+ |^Reading package lists|^Preparing to unpack|^Unpacking |^Setting up /i

/** Drop docker build / compose progress from the orchestrator (stack) pane. */
export function filterStackLogLine(line: string): boolean {
  const t = stripAnsi(line).trim()
  if (!t) return false

  if (t.startsWith("✗ ") || t.startsWith("⚠ ")) return true
  if (/https?:\/\//.test(t) || /^ws:\/\//.test(t)) return true
  if (/\[supatype\]/.test(line)) return true
  if (/^Services running/i.test(t)) return true
  if (/^(anon key|service_role|API \(Kong\)|REST API|Auth|Storage|Realtime|Studio|App|Demo data|Postgres|supatype-server|Press Ctrl)/.test(t)) {
    return true
  }
  if (/^Applied \d+ operation|^Schema up to date|^Schema pushed|^Watching .+ for changes|^Change detected|^Shutting down|^Compose stack stopped|^Local server image ready|^Building local server|^Waiting for |^Recreating server|^API config written|^provider: docker|^Bringing up Docker|^Schema push failed|^Initial schema push failed|^Storage bucket|^Storage API at|^Local binary overrides active|^Resolving component binaries|^Postgres |^Demo data:|^JWT secret:/.test(t)) {
    return true
  }
  if (/^\S+\s+→\s/.test(t)) return true
  if (isComposeProgressLine(t)) return false
  if (DOCKER_BUILD_NOISE.test(t)) return false
  if (/^Container\s+/i.test(t)) return false
  if (/^Image\s+/i.test(t)) return false
  if (/^network\s+\S+\s+(Creating|Created)/i.test(t)) return false
  if (/^volume\s+\S+\s+(Creating|Created)/i.test(t)) return false

  return false
}

/** Drop docker noise only — keep diff tables, push status, and command output. */
export function filterCommandLogLine(line: string): boolean {
  const t = stripAnsi(line).trim()
  if (!t) return false
  if (isComposeProgressLine(t)) return false
  if (DOCKER_BUILD_NOISE.test(t)) return false
  if (/^Container\s+/i.test(t)) return false
  if (/^Image\s+/i.test(t)) return false
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
