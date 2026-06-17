/**
 * Graceful shutdown for `supatype dev` — single path from SIGINT and TUI Ctrl+C.
 */

import { endDevSession } from "./dev-session.js"

let shutdownWork: (() => Promise<void>) | null = null
let shuttingDown = false
let signalsRegistered = false

function onSignal(): void {
  void runDevShutdown()
}

/** Register async teardown (stop children, compose down, etc.). Call once per dev session. */
export function registerDevShutdown(work: () => Promise<void>): void {
  shutdownWork = work
  if (signalsRegistered) return
  signalsRegistered = true
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
}

/** TUI Ctrl+C — do not re-emit SIGINT (avoids double-fire on Windows raw mode). */
export function requestDevShutdown(): void {
  void runDevShutdown()
}

export function isDevShuttingDown(): boolean {
  return shuttingDown
}

async function runDevShutdown(): Promise<void> {
  if (shuttingDown) {
    try {
      endDevSession()
    } catch {
      // best-effort terminal restore
    }
    process.stdout.write("\n")
    process.exit(130)
  }
  shuttingDown = true

  try {
    endDevSession()
    process.stdout.write("\n")
    await shutdownWork?.()
    process.exit(0)
  } catch (err) {
    process.stderr.write(`[supatype] Shutdown failed: ${(err as Error).message}\n`)
    process.exit(1)
  }
}
