/**
 * Hidden internal commands (Homebrew post_install, etc.).
 */

import type { Command } from "commander"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { isJsonObject } from "@supatype/shared"
import { downloadAll } from "../binary-cache.js"
import { error, info } from "../ui/messages.js"
import { errorMessage } from "../error-message.js"
import { collectSeedHere, importFile, isSeedJob } from "../seed-child.js"

/**
 * Exit 1 with the error on stderr: a caller parses stdout as JSON, and a message there would
 * corrupt it.
 */
function failToStderr(err: unknown): never {
  process.stderr.write(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
}

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
        error(errorMessage(err))
        process.exit(1)
      }
    })

  // Interpreter for the standalone binary. It carries the Bun runtime, so it can import
  // TypeScript directly; what it cannot do is spawn `node` with `tsx`, because a machine that
  // installed with `curl | sh` has neither, and neither is embedded. So the binary re-executes
  // itself for these jobs rather than reaching for a toolchain that is not there.
  //
  // Hidden and prefixed, like _postinstall: they are an implementation detail of config loading,
  // not commands anyone should run.
  program
    .command("_print-module <target>", { hidden: true })
    .description("Import a module and print its default export as JSON")
    .action(async (target: string) => {
      try {
        const href = target.startsWith("file:") ? target : pathToFileURL(resolve(target)).href
        const mod: unknown = await import(href)
        const value = (isJsonObject(mod) ? mod["default"] : undefined) ?? mod
        process.stdout.write(JSON.stringify(value))
      } catch (err) {
        failToStderr(err)
      }
    })

  program
    .command("_run-ts <file>", { hidden: true })
    .description("Execute a TypeScript file for its side effects")
    .action(async (file: string) => {
      try {
        await importFile(file)
      } catch (err) {
        failToStderr(err)
      }
    })

  program
    .command("_collect-seed <job>", { hidden: true })
    .description("Collect one seed file into its IR document, for `supatype seed`")
    .action(async (job: string) => {
      try {
        const parsed: unknown = JSON.parse(job)
        if (!isSeedJob(parsed)) throw new Error(`Not a seed job: ${job}`)
        await collectSeedHere(parsed)
      } catch (err) {
        failToStderr(err)
      }
    })
}
