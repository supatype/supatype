/**
 * Per-task log buffers for `supatype dev` TUI mode.
 */

export type DevLogLevel = "log" | "warn" | "error"

export interface DevTask {
  id: string
  title: string
  lines: string[]
  unread: boolean
}

const DEFAULT_MAX_LINES = 5_000

export class DevLogBus {
  private readonly tasks = new Map<string, DevTask>()
  private readonly order: string[] = []
  private readonly listeners = new Set<() => void>()
  private focusedTaskId = "stack"

  constructor(private readonly maxLines = DEFAULT_MAX_LINES) {
    this.registerTask("stack", "supatype")
  }

  registerTask(id: string, title: string): void {
    if (this.tasks.has(id)) return
    this.tasks.set(id, { id, title, lines: [], unread: false })
    this.order.push(id)
    this.notify()
  }

  ensureTask(id: string, title = id): void {
    this.registerTask(id, title)
  }

  getTaskOrder(): readonly string[] {
    return this.order
  }

  getTask(id: string): DevTask | undefined {
    return this.tasks.get(id)
  }

  getFocusedTaskId(): string {
    return this.focusedTaskId
  }

  setFocusedTaskId(id: string): void {
    if (!this.tasks.has(id)) return
    this.focusedTaskId = id
    const task = this.tasks.get(id)
    if (task) task.unread = false
    this.notify()
  }

  focusNext(): void {
    const idx = this.order.indexOf(this.focusedTaskId)
    const next = this.order[(idx + 1) % this.order.length]
    if (next) this.setFocusedTaskId(next)
  }

  focusPrevious(): void {
    const idx = this.order.indexOf(this.focusedTaskId)
    const prev = this.order[(idx - 1 + this.order.length) % this.order.length]
    if (prev) this.setFocusedTaskId(prev)
  }

  append(taskId: string, line: string, level: DevLogLevel = "log"): void {
    this.ensureTask(taskId, taskId)
    const task = this.tasks.get(taskId)
    if (!task) return

    const levelPrefix = level === "warn" ? "⚠ " : level === "error" ? "✗ " : ""
    const parts = line.split(/\r?\n/)

    for (const part of parts) {
      if (part.length === 0) continue
      const text = taskId === "stack" ? part.replace(/^\[supatype\]\s*/, "") : part
      if (text.length === 0) continue
      task.lines.push(levelPrefix + text)
      if (task.lines.length > this.maxLines) {
        task.lines.splice(0, task.lines.length - this.maxLines)
      }
    }

    if (taskId !== this.focusedTaskId && parts.some((p) => p.length > 0)) {
      task.unread = true
    }
    this.notify()
  }

  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
