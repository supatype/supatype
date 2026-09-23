import { getActiveFlowApi } from "./runtime/flow-session.js"
import { isInteractive } from "./interactive.js"
import { plainError, plainInfo, plainSuccess, plainWarn } from "./theme.js"

export const SUPATYPE_PREFIX = "[supatype]"

function writePlain(message = ""): void {
  console.log(message)
}

export function info(message: string): void {
  const api = getActiveFlowApi()
  if (api) {
    api.log.info(message)
    return
  }
  if (isInteractive()) {
    writePlain(plainInfo(message))
    return
  }
  writePlain(`${SUPATYPE_PREFIX} ${message}`)
}

export function warn(message: string): void {
  const api = getActiveFlowApi()
  if (api) {
    api.log.warn(message)
    return
  }
  if (isInteractive()) {
    writePlain(plainWarn(message))
    return
  }
  console.warn(`${SUPATYPE_PREFIX} ${message}`)
}

export function error(message: string): void {
  const api = getActiveFlowApi()
  if (api) {
    api.log.error(message)
    return
  }
  if (isInteractive()) {
    writePlain(plainError(message))
    return
  }
  console.error(`${SUPATYPE_PREFIX} ${message}`)
}

/** Unprefixed line (tables, diff output, blank lines). */
export function plain(message = ""): void {
  const api = getActiveFlowApi()
  if (api) {
    if (message === "") {
      api.note("")
      return
    }
    api.note(message)
    return
  }
  writePlain(message)
}

export function step(title: string): void {
  plain(`\n${title}`)
}

export type FileAction = "created" | "updated" | "skipped" | "removed" | "wrote"

export function file(action: FileAction, rel: string): void {
  plain(`  ${action}  ${rel}`)
}

export function success(message: string): void {
  const api = getActiveFlowApi()
  if (api) {
    api.log.success(message)
    return
  }
  if (isInteractive()) {
    writePlain(plainSuccess(message))
    return
  }
  plain(`${SUPATYPE_PREFIX} ${message}`)
}
