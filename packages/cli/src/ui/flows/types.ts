import type { ReactNode } from "react"
import type { DevSelectOption } from "../runtime/dev-prompt-queue.js"

export type FlowLogLevel = "info" | "warn" | "error" | "success" | "plain"

export interface FlowLogLine {
  level: FlowLogLevel
  text: string
}

export type ActiveFlowPrompt =
  | {
      kind: "confirm"
      message: string
      initialValue: boolean
    }
  | {
      kind: "text"
      message: string
      defaultValue?: string
      placeholder?: string
      validate?: (value: string) => string | undefined
    }
  | {
      kind: "password"
      message: string
    }
  | {
      kind: "select"
      message: string
      options: DevSelectOption[]
      initialValue?: string
    }

export interface FlowPromptHandle<T = unknown> {
  resolve: (value: T) => void
  reject: (err: Error) => void
}

export interface FlowController {
  appendLog(level: FlowLogLevel, text: string): void
  appendPlain(text: string): void
  setSpinner(message: string | null): void
  waitForPrompt<T>(spec: ActiveFlowPrompt): Promise<T>
}

export type FlowShellProps = {
  controller: FlowController
  children?: ReactNode
}
