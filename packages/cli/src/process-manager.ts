/**
 * ProcessManager — spawn a child process, write its PID, stream logs with a
 * colored prefix, and restart on crash with exponential backoff.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { join } from "node:path"

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
  /** Called when the process exits cleanly (code 0). */
  onExit?: () => void
  /** Use shell to spawn (required for pnpm/npm/yarn .cmd shims on Windows). */
  shell?: boolean
}

const RESET = "\x1b[0m"

export class ProcessManager {
  private child: ChildProcess | null = null
  private stopped = false
  private backoffMs: number
  private opts: Required<ProcessOptions>

  constructor(
    private readonly bin: string,
    private readonly args: string[],
    opts: ProcessOptions,
  ) {
    this.opts = {
      colour: "\x1b[36m",
      cwd: process.cwd(),
      env: {},
      initialBackoffMs: 1_000,
      maxBackoffMs: 30_000,
      onExit: () => {},
      shell: false,
      ...opts,
    }
    this.backoffMs = this.opts.initialBackoffMs
  }

  /** Start the process. Returns immediately — the process runs in the background. */
  start(): void {
    this.stopped = false
    this.spawn()
  }

  /** Stop the process and clear the PID file. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM")
      // Give it 5s to exit gracefully, then SIGKILL.
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.child?.kill("SIGKILL")
          resolve()
        }, 5_000)
        this.child!.once("exit", () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }
    await this.clearPid()
  }

  private spawn(): void {
    if (this.stopped) return

    const env = { ...process.env, ...this.opts.env } as NodeJS.ProcessEnv
    this.child = spawn(this.bin, this.args, {
      env,
      cwd: this.opts.cwd,
      stdio: "pipe",
      ...(this.opts.shell ? { shell: true } : {}),
    })

    const pid = this.child.pid
    if (pid) this.writePid(pid)

    const prefix = this.opts.colour
      ? `${this.opts.colour}[${this.opts.label}]${RESET} `
      : `[${this.opts.label}] `

    this.child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line) process.stdout.write(prefix + line + "\n")
      }
    })

    this.child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line) process.stderr.write(prefix + line + "\n")
      }
    })

    this.child.once("error", (err) => {
      if (this.stopped) return
      process.stderr.write(`${prefix}failed to start: ${err.message}\n`)
      setTimeout(() => {
        this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs)
        this.spawn()
      }, this.backoffMs)
    })

    this.child.once("exit", (code, signal) => {
      if (this.stopped) return

      if (code === 0) {
        this.opts.onExit()
        return
      }

      const reason = signal ? `signal ${signal}` : `code ${code}`
      process.stderr.write(
        `${prefix}process exited (${reason}), restarting in ${this.backoffMs}ms\n`,
      )

      setTimeout(() => {
        this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs)
        this.spawn()
      }, this.backoffMs)
    })
  }

  private writePid(pid: number): void {
    try {
      mkdirSync(this.opts.pidDir, { recursive: true })
      writeFileSync(join(this.opts.pidDir, `${this.opts.label}.pid`), String(pid))
    } catch {
      // Non-fatal — PID tracking is best-effort.
    }
  }

  private async clearPid(): Promise<void> {
    try {
      await unlink(join(this.opts.pidDir, `${this.opts.label}.pid`))
    } catch {
      // Ignore — file may already be gone.
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
