/**
 * Clack-compatible prompt API backed by Ink.
 * Use inside `runClackFlow()` for multi-step wizards, or via `confirm()` / `promptText()` helpers.
 */

import { getActiveDevSession } from "../dev-session.js"
import { createClackApi, type ClackApi } from "./clack-api.js"
import { isInteractive } from "./interactive.js"
import { CLACK_CANCEL, isCancel } from "./runtime/cancel.js"
import { enqueueDevPrompt } from "./runtime/dev-prompt-queue.js"
import { runClackFlow as mountClackFlow } from "./runtime/run-clack-flow.js"
import type { DevSelectOption } from "./runtime/dev-prompt-queue.js"

export { CLACK_CANCEL, isCancel }
export type { ClackApi } from "./clack-api.js"

import { getActiveFlowApi, setActiveFlowApi } from "./runtime/flow-session.js"

function inDevTui(): boolean {
  const session = getActiveDevSession()
  return Boolean(session?.isTui() && session.isInkMounted())
}

async function devOrFlow<T>(
  spec: Parameters<typeof enqueueDevPrompt>[0],
  flowFn: (api: ClackApi) => Promise<T>,
): Promise<T | typeof CLACK_CANCEL> {
  if (inDevTui()) {
    return enqueueDevPrompt(spec) as Promise<T | typeof CLACK_CANCEL>
  }
  const api = getActiveFlowApi()
  if (api) {
    return flowFn(api)
  }
  return mountClackFlow(async (flowApi) => flowFn(flowApi))
}

export async function runClackFlow<T>(run: (api: ClackApi) => Promise<T>): Promise<T> {
  return mountClackFlow(async (api) => {
    setActiveFlowApi(api)
    try {
      return await run(api)
    } finally {
      setActiveFlowApi(null)
    }
  })
}

export { getActiveFlowApi } from "./runtime/flow-session.js"

export const p: ClackApi = {
  intro(message) {
    const api = getActiveFlowApi()
    if (api) api.intro(message)
    else console.log(`\n${message}\n`)
  },
  outro(message) {
    const api = getActiveFlowApi()
    if (api) api.outro(message)
    else console.log(`\n${message}\n`)
  },
  note(message) {
    const api = getActiveFlowApi()
    if (api) api.note(message)
    else {
      for (const line of message.split("\n")) {
        if (line.trim()) console.log(`  ${line}`)
      }
    }
  },
  cancel(message): never {
    const api = getActiveFlowApi()
    if (api) {
      api.cancel(message)
    }
    console.log(message)
    process.exit(0)
  },
  async text(options) {
    return devOrFlow(
      {
        kind: "text",
        message: options.message,
        ...(options.defaultValue !== undefined ? { defaultValue: options.defaultValue } : {}),
        ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
        ...(options.validate !== undefined ? { validate: options.validate } : {}),
      },
      (api) => api.text(options),
    )
  },
  async password(options) {
    return devOrFlow({ kind: "password", message: options.message }, (api) => api.password(options))
  },
  async select<T extends string>(options: { message: string; options: DevSelectOption<T>[]; initialValue?: T }) {
    return devOrFlow(
      {
        kind: "select",
        message: options.message,
        options: options.options,
        ...(options.initialValue !== undefined ? { initialValue: options.initialValue as string | boolean } : {}),
      },
      (api) => api.select(options),
    )
  },
  async confirm(options) {
    return devOrFlow(
      {
        kind: "confirm",
        message: options.message,
        initialValue: options.initialValue ?? false,
      },
      (api) => api.confirm(options),
    )
  },
  spinner() {
    const api = getActiveFlowApi()
    if (api) return api.spinner()
    return {
      start(message: string) {
        console.log(`${message}...`)
      },
      stop(message: string) {
        console.log(message)
      },
    }
  },
  log: {
    info(message) {
      const api = getActiveFlowApi()
      if (api) api.log.info(message)
      else if (isInteractive()) console.log(message)
      else console.log(`[supatype] ${message}`)
    },
    warn(message) {
      const api = getActiveFlowApi()
      if (api) api.log.warn(message)
      else console.warn(`[supatype] ${message}`)
    },
    error(message) {
      const api = getActiveFlowApi()
      if (api) api.log.error(message)
      else console.error(`[supatype] ${message}`)
    },
    success(message) {
      const api = getActiveFlowApi()
      if (api) api.log.success(message)
      else console.log(`[supatype] ${message}`)
    },
  },
}

/** @deprecated Use `p` from this module inside `runClackFlow`. */
export { p as clack }
