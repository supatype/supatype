import * as p from "@clack/prompts"
import { isInteractive } from "./interactive.js"

export const SUPATYPE_PREFIX = "[supatype]"

export function info(message: string): void {
  if (isInteractive()) {
    p.log.info(message)
    return
  }
  console.log(`${SUPATYPE_PREFIX} ${message}`)
}

export function warn(message: string): void {
  if (isInteractive()) {
    p.log.warn(message)
    return
  }
  console.warn(`${SUPATYPE_PREFIX} ${message}`)
}

export function error(message: string): void {
  if (isInteractive()) {
    p.log.error(message)
    return
  }
  console.error(`${SUPATYPE_PREFIX} ${message}`)
}

/** Unprefixed line (tables, diff output, blank lines). */
export function plain(message = ""): void {
  console.log(message)
}

export function step(title: string): void {
  console.log(`\n${title}`)
}

export type FileAction = "created" | "updated" | "skipped" | "removed" | "wrote"

export function file(action: FileAction, rel: string): void {
  console.log(`  ${action}  ${rel}`)
}
