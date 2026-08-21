/**
 * Hidden internal commands (Homebrew post_install, etc.).
 */

import type { Command } from "commander"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { downloadAll } from "../binary-cache.js"
import { error, info } from "../ui/messages.js"

export function registerInternalCommands(program: Command): void {
  program
    .command("_postinstall", { hidden: true })
    .description("Prefetch CDN component binaries after install (Homebrew post_install)")
    .action(async () => {
      try {
        info("Prefetching Supatype component binaries for this platform...")
        await downloadAll(undefined, true)
        info("Component prefetch complete.")
      } catch (err) {
        error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })

  // Interpreter for the standalone binary. It carries the Bun runtime, so it can import
  // TypeScript directly; what it cannot do is spawn `node` with `tsx`, because a machine that
  // installed with `curl | sh` has neither, and neither is embedded. So the binary re-executes
  // itself for these two jobs rather than reaching for a toolchain that is not there.
  //
  // Hidden and prefixed, like _postinstall: they are an implementation detail of config loading,
  // not commands anyone should run.
  program
    .command("_print-module <target>", { hidden: true })
    .description("Import a module and print its default export as JSON")
    .action(async (target: string) => {
      try {
        const href = target.startsWith("file:") ? target : pathToFileURL(resolve(target)).href
        const mod = (await import(href)) as { default?: unknown }
        const value = mod.default ?? mod
        process.stdout.write(JSON.stringify(value))
      } catch (err) {
        // stderr, because the caller parses stdout as JSON and a message there would corrupt it.
        process.stderr.write(err instanceof Error ? (err.stack ?? err.message) : String(err))
        process.exit(1)
      }
    })

  program
    .command("_run-ts <file>", { hidden: true })
    .description("Execute a TypeScript file for its side effects")
    .action(async (file: string) => {
      try {
        await import(pathToFileURL(resolve(file)).href)
      } catch (err) {
        process.stderr.write(err instanceof Error ? (err.stack ?? err.message) : String(err))
        process.exit(1)
      }
    })
}
