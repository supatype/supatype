import type { HookDef } from "./types.js"

// ─── Model hook definitions ─────────────────────────────────────────────────────

export type HookTiming = "beforeChange" | "afterChange" | "beforeRead" | "afterDelete"

export interface HooksDef {
  beforeChange?: string
  afterChange?: string
  beforeRead?: string
  afterDelete?: string
}

/**
 * Convert the shorthand hooks config (`{ beforeChange: "./hooks/post-before.ts" }`)
 * to the full HookDef array used internally.
 */
export function resolveHooks(hooks: HooksDef): HookDef[] {
  const result: HookDef[] = []
  const timings: HookTiming[] = ["beforeChange", "afterChange", "beforeRead", "afterDelete"]
  for (const timing of timings) {
    const handler = hooks[timing]
    if (handler !== undefined) {
      result.push({ timing, handler })
    }
  }
  return result
}
