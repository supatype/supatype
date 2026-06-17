/**
 * supatype pg — manage the native Postgres instance for a project.
 *
 * Commands: start, stop, reset, psql
 */

import type { Command } from "commander"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../config.js"
import { resolveBinary } from "../binary-cache.js"
import {
  initdb,
  start as pgStart,
  stop as pgStop,
  waitReady,
} from "../postgres-ctl.js"

export function registerPg(program: Command): void {
  const pg = program
    .command("pg")
    .description("Manage the native Postgres instance for the current project")

  // ── start ────────────────────────────────────────────────────────────────
  pg.command("start")
    .description("Start Postgres for the current project")
    .action(async () => {
      const config = loadConfig()
      const opts = await pgOpts(config)
      initdb(opts)
      pgStart(opts)
      await waitReady(opts, 10_000)
      console.log(
        `[supatype] Postgres started on port ${opts.port} (data: ${opts.dataDir})`,
      )
    })

  // ── stop ─────────────────────────────────────────────────────────────────
  pg.command("stop")
    .description("Stop Postgres for the current project")
    .action(async () => {
      const config = loadConfig()
      const opts = await pgOpts(config)
      pgStop(opts)
      console.log("[supatype] Postgres stopped.")
    })

  // ── reset ─────────────────────────────────────────────────────────────────
  pg.command("reset")
    .description("Stop Postgres, wipe the data directory, and re-initialise")
    .option("--force", "Skip confirmation prompt")
    .action(async (opts: { force: boolean }) => {
      const config = loadConfig()
      const pgOpts_ = await pgOpts(config)

      if (!opts.force) {
        const readline = await import("node:readline")
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const answer = await new Promise<string>((resolve) =>
          rl.question(
            `This will DELETE all data in ${pgOpts_.dataDir}. Continue? [y/N] `,
            resolve,
          ),
        )
        rl.close()
        if (answer.toLowerCase() !== "y") {
          console.log("Aborted.")
          return
        }
      }

      pgStop(pgOpts_)
      if (existsSync(pgOpts_.dataDir)) {
        rmSync(pgOpts_.dataDir, { recursive: true, force: true })
        console.log(`[supatype] Data directory removed: ${pgOpts_.dataDir}`)
      }
      mkdirSync(pgOpts_.dataDir, { recursive: true })
      initdb(pgOpts_)
      pgStart(pgOpts_)
      await waitReady(pgOpts_, 10_000)
      console.log("[supatype] Postgres reset and started.")
    })

  // ── psql ─────────────────────────────────────────────────────────────────
  pg.command("psql [dbname]")
    .description("Open a psql shell connected to the project database")
    .action(async (dbname?: string) => {
      const config = loadConfig()
      const opts = await pgOpts(config)
      const db = dbname ?? config.project.name
      const psql = join(opts.pgBinDir, "psql")

      const result = spawnSync(
        psql,
        ["-h", "127.0.0.1", "-p", String(opts.port), "-U", "postgres", db],
        { stdio: "inherit" },
      )
      process.exit(result.status ?? 0)
    })
}

// ---------------------------------------------------------------------------
// Helper: build PgOptions from config
// ---------------------------------------------------------------------------

async function pgOpts(
  config: ReturnType<typeof loadConfig>,
): Promise<import("../postgres-ctl.js").PgOptions> {
  const projectName = config.project.name
  const stateRoot = join(homedir(), ".supatype", "projects", projectName)
  const dataDir = config.database.data_dir ?? join(stateRoot, "data")
  const logsDir = join(stateRoot, "logs")
  mkdirSync(logsDir, { recursive: true })

  // Resolve pg binary dir.
  const pgCacheDir = await (async () => {
    const override = config.overrides?.postgres_dir
    if (override) return join(override, "bin")
    const { cachePath, currentPlatform, resolveVersionFor } = await import("../binary-cache.js")
    const platform = currentPlatform()
    const version = await resolveVersionFor("postgres", config)
    return join(cachePath("postgres", version), `pg-${version}`, "bin")
  })()

  return {
    pgBinDir: pgCacheDir,
    dataDir,
    port: 5432,
    logPath: join(logsDir, "postgres.log"),
  }
}
