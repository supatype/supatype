/**
 * Interactive terminal UI for `supatype dev` — task list + focused log pane.
 */

import { stripAnsi } from "./dev-log-filter.js"
import type { DevLogBus } from "./dev-log-bus.js"
import {
  colorizeLogLine,
  colorizeTaskLabel,
  DIM,
  RESET,
  taskColor,
} from "./dev-task-colors.js"
import {
  colorLogoLines,
  layoutLogoBlock,
  logoRowCount,
  pickLogoLines,
} from "./dev-logo.js"
import { requestDevShutdown } from "./dev-shutdown.js"

const ENTER_ALT_SCREEN = "\x1b[?1049h"
const LEAVE_ALT_SCREEN = "\x1b[?1049l"
const HIDE_CURSOR = "\x1b[?25l"
const SHOW_CURSOR = "\x1b[?25h"
const CLEAR_SCREEN = "\x1b[2J\x1b[H"

const TASK_COL_WIDTH = 22
const MIN_WIDTH = 60
const MIN_HEIGHT = 14

export class DevTui {
  private active = false
  private scrollFromBottom = 0
  private renderPending = false
  private unsubscribeBus: (() => void) | null = null
  private readonly onResize = (): void => this.scheduleRender()
  private readonly onData = (chunk: Buffer): void => this.handleInput(chunk)

  constructor(private readonly bus: DevLogBus) {}

  start(): void {
    if (this.active) return
    this.active = true
    this.scrollFromBottom = 0

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.on("data", this.onData)
    }
    process.stdout.on("resize", this.onResize)

    process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR)
    this.unsubscribeBus = this.bus.onUpdate(() => this.scheduleRender())
    this.scheduleRender()
  }

  stop(): void {
    if (!this.active) return
    this.active = false

    this.unsubscribeBus?.()
    this.unsubscribeBus = null

    process.stdout.off("resize", this.onResize)
    if (process.stdin.isTTY) {
      process.stdin.off("data", this.onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }

    process.stdout.write(SHOW_CURSOR + LEAVE_ALT_SCREEN)
  }

  private scheduleRender(): void {
    if (!this.active || this.renderPending) return
    this.renderPending = true
    setImmediate(() => {
      this.renderPending = false
      if (this.active) this.render()
    })
  }

  private handleInput(chunk: Buffer): void {
    const key = chunk.toString()

    if (key === "\x03") {
      requestDevShutdown()
      return
    }

    switch (key) {
      case "j":
      case "\x1b[B":
        this.bus.focusNext()
        this.scrollFromBottom = 0
        break
      case "k":
      case "\x1b[A":
        this.bus.focusPrevious()
        this.scrollFromBottom = 0
        break
      case "u":
        this.scrollFromBottom = Math.min(
          this.scrollFromBottom + 3,
          this.maxScroll(this.bus.getFocusedTaskId()),
        )
        break
      case "d":
        this.scrollFromBottom = Math.max(this.scrollFromBottom - 3, 0)
        break
      case "g":
        this.scrollFromBottom = this.maxScroll(this.bus.getFocusedTaskId())
        break
      case "G":
        this.scrollFromBottom = 0
        break
      default:
        return
    }
    this.scheduleRender()
  }

  private maxScroll(taskId: string): number {
    const task = this.bus.getTask(taskId)
    if (!task) return 0
    const logHeight = this.splitPaneHeight()
    return Math.max(0, task.lines.length - logHeight)
  }

  private chromeRowCount(): number {
    // logo + separator + keybind hint + footer
    return logoRowCount() + 3
  }

  private splitPaneHeight(): number {
    const rows = Math.max(MIN_HEIGHT, process.stdout.rows ?? 24)
    return Math.max(4, rows - this.chromeRowCount())
  }

  private render(): void {
    const cols = Math.max(MIN_WIDTH, process.stdout.columns ?? 80)
    const logWidth = cols - TASK_COL_WIDTH - 1
    const logHeight = this.splitPaneHeight()

    const lines: string[] = []

    const logoPlain = layoutLogoBlock(pickLogoLines())
    for (const colored of colorLogoLines(logoPlain)) {
      lines.push(formatLogoRow(colored, cols))
    }

    lines.push(`${DIM}${"─".repeat(cols)}${RESET}`)
    lines.push(
      `${DIM}${truncate(
        " ↑/k ↓/j task  u/d scroll  g/G top/bottom  Ctrl+C quit",
        cols,
      )}${RESET}`,
    )

    const taskIds = this.bus.getTaskOrder()
    const focusedId = this.bus.getFocusedTaskId()

    for (let row = 0; row < logHeight; row++) {
      let left = " ".repeat(TASK_COL_WIDTH)
      const taskId = taskIds[row]
      if (taskId) {
        const task = this.bus.getTask(taskId)
        if (task) {
          const marker = taskId === focusedId ? "▶" : " "
          const unread = task.unread ? " •" : "  "
          const label = truncate(`${marker} ${task.title}${unread}`, TASK_COL_WIDTH - 1)
          left = padVisible(
            colorizeTaskLabel(taskId, label, taskId === focusedId),
            TASK_COL_WIDTH,
          )
        }
      }

      const logLine = this.logLineAt(focusedId, row, logHeight, logWidth)
      lines.push(left + `${DIM}│${RESET}` + logLine)
    }

    const focusedTitle = this.bus.getTask(focusedId)?.title ?? focusedId
    lines.push(`${DIM} focused:${RESET} ${colorizeTaskLabel(focusedId, focusedTitle, true)}`)

    process.stdout.write(CLEAR_SCREEN + lines.join("\n"))
  }

  private logLineAt(taskId: string, row: number, logHeight: number, width: number): string {
    const task = this.bus.getTask(taskId)
    if (!task || task.lines.length === 0) {
      return " ".repeat(width)
    }

    const total = task.lines.length
    const end = total - this.scrollFromBottom
    const start = Math.max(0, end - logHeight)
    const index = start + row
    if (index >= end || index >= total) {
      return " ".repeat(width)
    }

    const raw = stripAnsi(task.lines[index] ?? "")
    const clipped = truncate(raw, width)
    return padVisible(colorizeLogLine(taskId, clipped), width)
  }
}

function truncate(text: string, width: number): string {
  if (width <= 0) return ""
  if (text.length <= width) return text
  if (width <= 1) return text.slice(0, width)
  return `${text.slice(0, width - 1)}…`
}

/** Pad to visible width (ignores ANSI sequences already stripped from input). */
function padVisible(text: string, width: number): string {
  const visible = stripAnsi(text)
  if (visible.length >= width) return text
  return text + " ".repeat(width - visible.length)
}

function formatLogoRow(colored: string, cols: number): string {
  const plain = stripAnsi(colored)
  if (plain.length <= cols) {
    return plain.length < cols ? `${colored}${" ".repeat(cols - plain.length)}` : colored
  }
  const purple = taskColor("stack")
  return `${purple}\x1b[1m${plain.slice(0, cols)}${RESET}`
}
