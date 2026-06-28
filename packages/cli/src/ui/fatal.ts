import type { DockerBrandOptions } from "../docker-runtime.js"
import { isInteractive } from "./interactive.js"
import { error, plain } from "./messages.js"
import { printLogo } from "./prompts.js"

export type FatalOptions = {
  brand?: DockerBrandOptions
  exitCode?: number
}

/** Print a fatal headline + optional hint block, then exit. */
export function fatalError(message: string, hints: string[] = [], opts?: FatalOptions): never {
  if (opts?.brand && isInteractive()) {
    printLogo()
    plain(opts.brand.intro)
  }

  error(message)

  if (hints.length > 0) {
    for (const hint of hints) {
      plain()
      plain(`  ${hint}`)
    }
  }

  process.exit(opts?.exitCode ?? 1)
}

/** Top-level CLI catch — user-facing message without branding. */
export function reportCliFatal(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  error(message)
  if (process.env["SUPATYPE_DEBUG"] === "1" && err instanceof Error && err.stack) {
    plain()
    plain(err.stack)
  }
}
