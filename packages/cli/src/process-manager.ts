/**
 * ProcessManager: spawn a child process, write its PID, stream logs with a
 * colored prefix, and restart on crash with exponential backoff.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { enhanceProcessOptions } from "./dev-session.js"
import { errorMessage } from "./error-message.js"
import { endTreeOnExit, stopTree, treeSpawnOptions } from "./process-tree.js"

export interface ProcessOptions {
  /** Human-readable label (used in log prefix and PID filename). */
  label: string
  /** Directory to write {label}.pid to. */
  pidDir: string
  /** ANSI colour prefix string (e.g. "\x1b[36m"). Pass "" for no colour. */
  colour?: string
  /** Working directory for the spawned process. Defaults to process.cwd(). */
  cwd?: string
  /** Environment variables to merge with process.env. */
  env?: Record<string, string>
  /** Initial restart backoff in ms. Doubles each crash up to maxBackoffMs. */
  initialBackoffMs?: number
  /** Maximum restart backoff cap in ms. */
  maxBackoffMs?: number
  /** A crash this soon after the start counts toward {@link FAST_CRASH_LIMIT}. Default 5s. */
  fastCrashMs?: number
  /** A crash-looping process is left stopped once the wait before its next restart reaches this. Default 5 minutes. */
  giveUpWaitMs?: number
  /**
   * Called when the process stops for good: a clean exit (code 0), `finalExitCode`, or crashing as
   * it starts too often. It is not restarted after any of them.
   */
  onStopped?: () => void
  /** A non-zero exit code that means restarting cannot help, so the process is left stopped. */
  finalExitCode?: number
  /** Use shell to spawn (required for pnpm/npm/yarn .cmd shims on Windows). */
  shell?: boolean
  /**
   * When set (TUI mode), receive log lines instead of writing to stdout/stderr. Each is a whole
   * line without its line ending, and a line just received from the other stream is not repeated.
   */
  onLine?: (line: string, stream: "stdout" | "stderr") => void
  /** Return false to drop a line before logging. */
  shouldLogLine?: (line: string) => boolean
  /**
   * Called before the first spawn (e.g. free a stale port). The spawn waits for a returned promise,
   * and goes ahead when it rejects, after reporting why.
   */
  beforeStart?: () => void | Promise<void>
  /** Called before auto-restart after a non-zero exit, and awaited like `beforeStart`. */
  beforeRestart?: () => void | Promise<void>
}

const RESET = "\x1b[0m"

/**
 * Crashes in a row, each soon after its start, after which a process is crash-looping: it is said
 * so once, and its wait keeps doubling past `maxBackoffMs` until it reaches `giveUpWaitMs`.
 */
export const FAST_CRASH_LIMIT = 5

type OutputStream = "stdout" | "stderr"

/**
 * Drops the carriage return that ends a CRLF line. A line redrawn with bare carriage returns (a
 * progress counter) keeps only its last state, which is what a terminal would show.
 */
function lastCarriageSegment(line: string): string {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line
  return trimmed.slice(trimmed.lastIndexOf("\r") + 1)
}

/**
 * Turns a stream's reads into whole lines. A read ends wherever the pipe's buffer did, so a line
 * can arrive in pieces, and each piece was logged as a line of its own. The text after the last
 * newline now waits for the rest of its line, or for the stream to end.
 */
export class LineBuffer {
  private pending = ""

  constructor(private readonly emit: (line: string) => void) {}

  push(text: string): void {
    const parts = (this.pending + text).split("\n")
    const tail = parts.pop() ?? ""
    // A progress line redrawn with bare carriage returns would otherwise grow for as long as it
    // runs. Only its last state is kept; a final "\r" stays, as it may be half of a CRLF.
    const redrawn = tail.lastIndexOf("\r", tail.length - 2)
    this.pending = redrawn >= 0 ? tail.slice(redrawn + 1) : tail
    for (const part of parts) this.emit(lastCarriageSegment(part))
  }

  /** Emit the unterminated tail: the stream has ended and nothing more of it is coming. */
  flush(): void {
    if (this.pending === "") return
    const rest = this.pending
    this.pending = ""
    this.emit(lastCarriageSegment(rest))
  }
}

/**
 * npm prints a script's banner to both streams, so a line just logged from the other stream is a
 * repeat. The same line twice on one stream is the program's own output (two identical request
 * errors, say) and was being dropped along with the banners.
 */
class CrossStreamRepeats {
  private lastLine: string | null = null
  private lastStream: OutputStream | null = null

  isRepeat(line: string, stream: OutputStream): boolean {
    const repeat = this.lastLine === line && this.lastStream !== stream
    this.lastLine = line
    this.lastStream = stream
    return repeat
  }
}

export class ProcessManager {
  private child: ChildProcess | null = null
  private stopped = false
  private backoffMs: number
  /** Crashes in a row, each within `fastCrashMs` of its start. */
  private fastCrashes = 0
  private opts: ProcessOptions & {
    colour: string
    cwd: string
    env: Record<string, string>
    initialBackoffMs: number
    maxBackoffMs: number
    fastCrashMs: number
    giveUpWaitMs: number
    onStopped: () => void
    shell: boolean
  }
  private readonly prefix: string

  constructor(
    private readonly bin: string,
    private readonly args: string[],
    opts: ProcessOptions,
  ) {
    const merged = enhanceProcessOptions(opts.label, opts)
    this.opts = {
      colour: "\x1b[36m",
      cwd: process.cwd(),
      env: {},
      initialBackoffMs: 1_000,
      maxBackoffMs: 30_000,
      fastCrashMs: 5_000,
      giveUpWaitMs: 300_000,
      onStopped: () => {},
      shell: false,
      ...merged,
    }
    this.backoffMs = this.opts.initialBackoffMs
    this.prefix = this.opts.colour
      ? `${this.opts.colour}[${this.opts.label}]${RESET} `
      : `[${this.opts.label}] `
  }

  /** Start the process. Returns immediately, the process runs in the background. */
  start(): void {
    this.stopped = false
    void this.spawnAfter(this.opts.beforeStart)
  }

  /**
   * Stop the process and everything it started, and clear the PID file. Ending the process alone
   * left what it started running: the server's Deno worker kept the functions port (FF12).
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.child) await stopTree(this.child)
    await this.clearPid()
  }

  /** Spawns once `hook` has finished, unless stop() was called while it ran. */
  private async spawnAfter(hook: (() => void | Promise<void>) | undefined): Promise<void> {
    try {
      await hook?.()
    } catch (err) {
      this.report(`could not prepare the start, starting anyway: ${errorMessage(err)}`)
    }
    this.spawn()
  }

  private spawn(): void {
    if (this.stopped) return

    const child = spawn(this.bin, this.args, {
      env: { ...process.env, ...this.opts.env } as NodeJS.ProcessEnv,
      cwd: this.opts.cwd,
      stdio: "pipe",
      ...(this.opts.shell ? { shell: true } : {}),
      ...treeSpawnOptions(),
    })
    this.child = child
    if (child.pid) this.writePid(child.pid)
    endTreeOnExit(child)
    this.pipeOutput(child)
    const startedAt = Date.now()

    child.once("error", (err) => {
      if (this.stopped) return
      this.restartUnlessLooping(`failed to start: ${err.message}`, startedAt)
    })

    child.once("exit", (code, signal) => {
      if (this.stopped) return
      if (code === 0) {
        this.opts.onStopped()
        return
      }
      const what = `process exited (${signal ? `signal ${signal}` : `code ${code}`})`
      if (code === this.opts.finalExitCode) this.leaveStopped(what)
      else this.restartUnlessLooping(what, startedAt)
    })
  }

  /**
   * Restarts after a crash. From the {@link FAST_CRASH_LIMIT}th in a row within `fastCrashMs` of its
   * start, the wait doubles past `maxBackoffMs`, so a fix to what it needs is still picked up, and
   * once the wait reaches `giveUpWaitMs` it is left stopped. A run that lasted resets both.
   */
  private restartUnlessLooping(what: string, startedAt: number): void {
    if (Date.now() - startedAt < this.opts.fastCrashMs) {
      this.fastCrashes++
    } else {
      this.fastCrashes = 0
      this.backoffMs = this.opts.initialBackoffMs
    }
    if (this.crashLooping() && this.backoffMs >= this.opts.giveUpWaitMs) {
      this.leaveStopped(`${what}, still crashing as it starts`, "Fix the error above, then restart supatype dev.")
      return
    }
    if (this.fastCrashes === FAST_CRASH_LIMIT) {
      const seconds = this.opts.fastCrashMs / 1_000
      this.report(`it has exited ${this.fastCrashes} times in a row within ${seconds}s of starting, so it is retried less often`)
    }
    this.report(`${what}, restarting in ${this.backoffMs}ms`)
    this.scheduleRestart()
  }

  private crashLooping(): boolean {
    return this.fastCrashes >= FAST_CRASH_LIMIT
  }

  /** Says the process is not restarted, and why, and tells the caller it has stopped for good. */
  private leaveStopped(what: string, advice?: string): void {
    this.report(`${what}, not restarting it.${advice !== undefined ? ` ${advice}` : ""}`)
    this.opts.onStopped()
  }

  /**
   * Logs the child's output a whole line at a time. Repeats are tracked per run: carried over, a
   * crashing program's error was dropped on every restart as a repeat of the run before, so the
   * log showed it once and then only the restarts.
   */
  private pipeOutput(child: ChildProcess): void {
    const repeats = new CrossStreamRepeats()
    for (const stream of ["stdout", "stderr"] as const) {
      const lines = new LineBuffer((line) => this.logLine(line, stream, repeats))
      const source = child[stream]
      if (!source) continue
      // Decoded as a stream, so a character split across two reads (Vite's "➜") stays whole.
      source.setEncoding("utf8")
      source.on("data", (text: string) => lines.push(text))
      source.on("end", () => lines.flush())
    }
  }

  private logLine(line: string, stream: OutputStream, repeats: CrossStreamRepeats): void {
    if (!line) return
    if (this.opts.shouldLogLine && !this.opts.shouldLogLine(line)) return
    if (repeats.isRepeat(line, stream)) return
    if (this.opts.onLine) {
      this.opts.onLine(line, stream)
      return
    }
    const target = stream === "stderr" ? process.stderr : process.stdout
    target.write(this.prefix + line + "\n")
  }

  /** A message of the manager's own about the process: the dashboard pane, or stderr. */
  private report(message: string): void {
    if (this.opts.onLine) {
      this.opts.onLine(message, "stderr")
      return
    }
    process.stderr.write(`${this.prefix}${message}\n`)
  }

  private scheduleRestart(): void {
    setTimeout(() => {
      this.backoffMs = this.crashLooping() ? this.backoffMs * 2 : Math.min(this.backoffMs * 2, this.opts.maxBackoffMs)
      void this.spawnAfter(this.opts.beforeRestart)
    }, this.backoffMs)
  }

  private writePid(pid: number): void {
    try {
      mkdirSync(this.opts.pidDir, { recursive: true })
      writeFileSync(join(this.opts.pidDir, `${this.opts.label}.pid`), String(pid))
    } catch {
      // Non-fatal: PID tracking is best-effort.
    }
  }

  private async clearPid(): Promise<void> {
    try {
      await unlink(join(this.opts.pidDir, `${this.opts.label}.pid`))
    } catch {
      // Ignore: file may already be gone.
    }
  }
}

/** Read a PID from a file (returns null if not found or stale). */
export function readPid(pidDir: string, label: string): number | null {
  const pidFile = join(pidDir, `${label}.pid`)
  if (!existsSync(pidFile)) return null
  const raw = readFileSync(pidFile, "utf8").trim()
  const pid = Number(raw)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}
