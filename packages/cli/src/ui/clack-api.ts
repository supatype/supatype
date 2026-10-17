import type { FlowController } from "./flows/types.js"
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

export function createClackApi(controller: FlowController): ClackApi {
  return {
    intro(message) {
      controller.appendLog("plain", message)
    },
    outro(message) {
      controller.appendLog("success", message)
    },
    note(message) {
      for (const line of message.split("\n")) {
        if (line.trim()) controller.appendPlain(line)
      }
    },
    cancel(message): never {
      controller.appendLog("warn", message)
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
        start(message: string) {
          controller.setSpinner(message)
        },
        stop(message: string) {
          controller.setSpinner(null)
          controller.appendLog("success", message)
        },
      }
    },
    log: {
      info(message) {
        controller.appendLog("info", message)
      },
      warn(message) {
        controller.appendLog("warn", message)
      },
      error(message) {
        controller.appendLog("error", message)
      },
      success(message) {
        controller.appendLog("success", message)
      },
    },
  }
}
