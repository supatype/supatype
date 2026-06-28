/**
 * Graceful shutdown for `supatype dev` — SIGINT, TUI Ctrl+C, terminal close,
 * and a synchronous compose-down fallback on process exit.
 */

import { existsSync } from "node:fs"
import { endDevSession } from "./dev-session.js"
import { clearDevSessionLock } from "./dev-session-lock.js"
import { runDockerCompose } from "./self-host-compose.js"

export interface DevComposeShutdownFallback {
  cwd: string
  composePath: string
  composeProject: string
}

let shutdownWork: (() => Promise<void>) | null = null
let composeFallback: DevComposeShutdownFallback | null = null
let shutdownCwd: string | null = null
let shuttingDown = false
let shutdownCompleted = false
let forceQuitRequested = false
let hooksRegistered = false
let ignoreSigintUntil = 0

/** SIGINT/SIGTERM hooks — call as soon as `supatype dev` starts (before compose is up). */
export function ensureDevShutdownHooks(): void {
  if (hooksRegistered) return
  hooksRegistered = true

  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  if (process.platform === "win32") {
    process.on("SIGBREAK", onSignal)
  }
  process.on("exit", onProcessExit)

  if (process.stdin.isTTY) {
    process.stdin.on("end", onStdinClose)
    process.stdin.on("close", onStdinClose)
  }
}

function onSignal(): void {
  if (Date.now() < ignoreSigintUntil) return
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
      { quiet: true },
    )
  } catch {
    // best-effort — process is exiting
  }
  if (shutdownCwd) clearDevSessionLock(shutdownCwd)
}

function onProcessExit(): void {
  syncComposeDownFallback()
}

export interface RegisterDevShutdownOptions {
  /** Sync `docker compose down` when async teardown cannot finish (terminal close, kill). */
  compose?: DevComposeShutdownFallback
  /** Project root — clears `.supatype/dev-session.json` after shutdown. */
  cwd?: string
}

/** Register async teardown (stop children, compose down, etc.). Call once per dev session. */
export function registerDevShutdown(
  work: () => Promise<void>,
  opts?: RegisterDevShutdownOptions,
): void {
  shutdownWork = work
  composeFallback = opts?.compose ?? null
  shutdownCwd = opts?.cwd ?? opts?.compose?.cwd ?? null
  ensureDevShutdownHooks()
}

/** TUI Ctrl+C — do not re-emit SIGINT (avoids double-fire on Windows raw mode). */
export function requestDevShutdown(): void {
  ignoreSigintUntil = Date.now() + 400
  void runDevShutdown()
}

export function isDevShuttingDown(): boolean {
  return shuttingDown
}

/** @internal Tests — reset module state between cases. */
export function resetDevShutdownForTests(): void {
  shutdownWork = null
  composeFallback = null
  shutdownCwd = null
  shuttingDown = false
  shutdownCompleted = false
  forceQuitRequested = false
  hooksRegistered = false
  ignoreSigintUntil = 0
}

async function runDevShutdown(): Promise<void> {
  if (shuttingDown) {
    if (!forceQuitRequested) {
      forceQuitRequested = true
      process.stderr.write(
        "\n[supatype] Still shutting down (stopping Docker)… press Ctrl+C again to force quit.\n",
      )
      return
    }
    try {
      endDevSession()
    } catch {
      // best-effort terminal restore
    }
    process.stderr.write("\n[supatype] Forced quit — Docker containers may still be running.\n")
    process.stdout.write("\n")
    process.exit(130)
  }
  shuttingDown = true

  try {
    endDevSession()
    process.stderr.write("\n[supatype] Shutting down…\n")
    if (!shutdownWork) {
      if (shutdownCwd) clearDevSessionLock(shutdownCwd)
      process.exit(130)
    }
    await shutdownWork()
    shutdownCompleted = true
    if (shutdownCwd) clearDevSessionLock(shutdownCwd)
    process.exit(0)
  } catch (err) {
    process.stderr.write(`[supatype] Shutdown failed: ${(err as Error).message}\n`)
    process.stderr.write(
      "[supatype] Docker containers may still be running — try: supatype self-host compose down\n",
    )
    syncComposeDownFallback()
    shutdownCompleted = true
    process.exit(1)
  }
}

/** Whether a compose fallback was registered (tests). */
export function hasComposeShutdownFallback(): boolean {
  return composeFallback !== null && existsSync(composeFallback.composePath)
}
