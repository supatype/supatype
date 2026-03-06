import type { Command } from "commander"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { runTsFile } from "../tsx-runner.js"

export function registerSeed(program: Command): void {
  program
    .command("seed [file]")
    .description("Run seed.ts (or a custom seed file) against the database")
    .action((file?: string) => {
      const cwd = process.cwd()
      const seedFile = resolve(cwd, file ?? "seed.ts")

      if (!existsSync(seedFile)) {
        console.error(`Seed file not found: ${seedFile}`)
        process.exit(1)
      }

      console.log(`Running ${seedFile}...`)
      const result = runTsFile(seedFile, { cwd, stdio: "inherit" })

      if (result.exitCode !== 0) {
        process.exit(result.exitCode)
      }
    })
}
