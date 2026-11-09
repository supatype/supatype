import type { FlowController, FlowLogLevel } from "./flows/types.js"
import type { DevSelectOption } from "./runtime/dev-prompt-queue.js"
import { isBoolean, isString, type Guard } from "@supatype/shared"
import { CLACK_CANCEL, promptAnswer } from "./runtime/cancel.js"

/** An answer that is one of the select's own option values. */
export function isOptionOf<T extends string>(options: readonly DevSelectOption<T>[]): Guard<T> {
  return (value: unknown): value is T => options.some((option) => option.value === value)
}

export interface ClackTextOptions {
  message: string
  defaultValue?: string
  placeholder?: string
  validate?: (value: string) => string | undefined
}

export interface ClackSelectOptions<T extends string = string> {
  message: string
  options: DevSelectOption<T>[]
  initialValue?: T
}

export interface ClackConfirmOptions {
  message: string
  initialValue?: boolean
}

export interface ClackPasswordOptions {
  message: string
}

export interface ClackSpinner {
  start(message: string): void
  stop(message: string): void
}

export interface ClackApi {
  intro(message: string): void
  outro(message: string): void
  note(message: string): void
  cancel(message: string): never
  text(options: ClackTextOptions): Promise<string | typeof CLACK_CANCEL>
  password(options: ClackPasswordOptions): Promise<string | typeof CLACK_CANCEL>
  select<T extends string>(options: ClackSelectOptions<T>): Promise<T | typeof CLACK_CANCEL>
  confirm(options: ClackConfirmOptions): Promise<boolean | typeof CLACK_CANCEL>
  spinner(): ClackSpinner
  log: {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
    success(message: string): void
  }
}

/**
 * `controller`'s log, with a turning spinner's message kept above the first line logged under it.
 * The spinner's line used to be logged only when it stopped, after everything the work it covers
 * had logged, so `push` printed "Schema pushed." above "Applying schema via Docker Compose".
 */
class SpinnerLog {
  private spinning: { message: string; shown: boolean } | null = null

  constructor(private readonly controller: FlowController) {}

  append(level: FlowLogLevel, text: string): void {
    this.showSpinnerLine()
    this.controller.appendLog(level, text)
  }

  start(message: string): void {
    this.spinning = { message, shown: false }
    this.controller.setSpinner(message)
  }

  /** The done line, unless it is the spinner's own line, already shown above the work's. */
  stop(message: string): void {
    const shown = this.spinning?.shown === true && this.spinning.message === message
    this.spinning = null
    this.controller.setSpinner(null)
    if (!shown) this.controller.appendLog("success", message)
  }

  private showSpinnerLine(): void {
    if (this.spinning === null || this.spinning.shown) return
    this.spinning.shown = true
    this.controller.appendLog("info", this.spinning.message)
  }
}

export function createClackApi(controller: FlowController): ClackApi {
  const log = new SpinnerLog(controller)
  return {
    intro(message) {
      log.append("plain", message)
    },
    outro(message) {
      log.append("success", message)
    },
    note(message) {
      for (const line of message.split("\n")) {
        if (line.trim()) log.append("plain", line)
      }
    },
    cancel(message): never {
      log.append("warn", message)
      process.exit(0)
    },
    async text(options) {
      const answer = await controller.waitForPrompt({
        kind: "text",
        message: options.message,
        ...(options.defaultValue !== undefined ? { defaultValue: options.defaultValue } : {}),
        ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
        ...(options.validate !== undefined ? { validate: options.validate } : {}),
      })
      return promptAnswer(answer, isString)
    },
    async password(options) {
      const answer = await controller.waitForPrompt({ kind: "password", message: options.message })
      return promptAnswer(answer, isString)
    },
    async select<T extends string>(options: ClackSelectOptions<T>) {
      const answer = await controller.waitForPrompt({
        kind: "select",
        message: options.message,
        options: options.options,
        ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
      })
      return promptAnswer(answer, isOptionOf(options.options))
    },
    async confirm(options) {
      const answer = await controller.waitForPrompt({
        kind: "confirm",
        message: options.message,
        initialValue: options.initialValue ?? false,
      })
      return promptAnswer(answer, isBoolean)
    },
    spinner() {
      return {
        start: (message: string) => log.start(message),
        stop: (message: string) => log.stop(message),
      }
    },
    log: {
      info: (message) => log.append("info", message),
      warn: (message) => log.append("warn", message),
      error: (message) => log.append("error", message),
      success: (message) => log.append("success", message),
    },
  }
}
