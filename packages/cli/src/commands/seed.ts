import type { Command } from "commander"
import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { isLinkedToCloudProject } from "../binary-cache.js"
import { loadConfig } from "../config.js"
import { projectRootFromConfig } from "../project-config.js"
import { runTsFile } from "../tsx-runner.js"
import { error, info } from "../ui/messages.js"

const SEED_EXT = /\.(ts|mts|tsx)$/

/** Seed entries under `seeds/`, sorted by filename (Phase 10.6 C19). */
export function discoverSeedsDir(cwd: string, seedsDir: string): string[] {
  if (!existsSync(seedsDir)) return []
  const names = readdirSync(seedsDir).filter((n) => SEED_EXT.test(n))
  names.sort((a, b) => a.localeCompare(b))
  return names.map((n) => join(seedsDir, n))
}

export function registerSeed(program: Command): void {
  program
    .command("seed [file]")
    .description(
      "Run database seeds: optional single file; else all seeds/*.ts (alphabetical); else seed.ts",
    )
    .option(
      "--force",
      "Allow running when the project is linked to Supatype Cloud (dangerous)",
      false,
    )
    .action(async (file: string | undefined, opts: { force: boolean }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      if (isLinkedToCloudProject(cwd, config) && !opts.force) {
        error(
          "This project is linked to Supatype Cloud. Refusing to run seeds locally.\n" +
            "  Pass --force only if you intend to target this linked project (advanced).",
        )
        process.exit(1)
      }

      const root = projectRootFromConfig(config, cwd)
      const seedsDir = join(root, "seeds")

      let paths: string[]
      if (file !== undefined && file.trim() !== "") {
        paths = [resolve(cwd, file)]
      } else {
        paths = discoverSeedsDir(cwd, seedsDir)
        if (paths.length === 0) {
          paths = [resolve(root, "seed.ts")]
        }
      }

      const missing = paths.filter((p) => !existsSync(p))
      if (missing.length > 0) {
        error(`Seed file(s) not found:\n  ${missing.join("\n  ")}`)
        process.exit(1)
      }

      for (const seedFile of paths) {
        info(`Running ${seedFile}...`)
        const result = runTsFile(seedFile, { cwd, stdio: "inherit" })
        if (result.exitCode !== 0) {
          process.exit(result.exitCode)
        }
      }
    })
}
