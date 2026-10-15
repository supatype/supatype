/**
 * supatype pg: manage the native Postgres instance for a project.
 *
 * Commands: start, stop, reset, psql
 */

import type { Command } from "commander"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../config.js"
import { nativeDataDir, nativeDbPort, nativeStateRoot } from "../project-config.js"
import { confirm } from "../ui/confirm.js"
import { info, plain } from "../ui/messages.js"
import {
  initdb,
  pgBin,
  start as pgStart,
  stop as pgStop,
  waitReady,
  type PgOptions,
} from "../postgres-ctl.js"
import { pgClientEnv, requirePasswordAuth, requireSuperuserPassword } from "../native-pg-auth.js"
import { devPostgresPassword, ensureNativeSuperuserPassword } from "../local-secrets.js"

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
      requireSuperuserPassword(process.cwd(), opts.dataDir)
      const password = ensureNativeSuperuserPassword(process.cwd())
      initdb(opts, password)
      pgStart(opts)
      await waitReady(opts, 10_000)
      requirePasswordAuth(opts, password)
      info(`Postgres started on port ${opts.port} (data: ${opts.dataDir})`)
    })

  // ── stop ─────────────────────────────────────────────────────────────────
  pg.command("stop")
    .description("Stop Postgres for the current project")
    .action(async () => {
      const config = loadConfig()
      const opts = await pgOpts(config)
      pgStop(opts)
      info("Postgres stopped.")
    })

  // ── reset ─────────────────────────────────────────────────────────────────
  pg.command("reset")
    .description("Stop Postgres, wipe the data directory, and re-initialise")
    .option("--force", "Skip confirmation prompt")
    .action(async (opts: { force: boolean }) => {
      const config = loadConfig()
      const pgOpts_ = await pgOpts(config)

      if (!opts.force) {
        const ok = await confirm(
          `This will DELETE all data in ${pgOpts_.dataDir}. Continue?`,
          { default: false },
        )
        if (!ok) {
          plain("Aborted.")
          return
        }
      }

      pgStop(pgOpts_)
      if (existsSync(pgOpts_.dataDir)) {
        rmSync(pgOpts_.dataDir, { recursive: true, force: true })
        info(`Data directory removed: ${pgOpts_.dataDir}`)
      }
      mkdirSync(pgOpts_.dataDir, { recursive: true })
      const password = ensureNativeSuperuserPassword(process.cwd())
      initdb(pgOpts_, password)
      pgStart(pgOpts_)
      await waitReady(pgOpts_, 10_000)
      info("Postgres reset and started.")
    })

  // ── psql ─────────────────────────────────────────────────────────────────
  pg.command("psql [dbname]")
    .description("Open a psql shell connected to the project database")
    .action(async (dbname?: string) => {
      const config = loadConfig()
      const opts = await pgOpts(config)
      const db = dbname ?? config.project.name
      const psql = pgBin(opts.pgBinDir, "psql")

      const result = spawnSync(
        psql,
        ["-h", "127.0.0.1", "-p", String(opts.port), "-U", "postgres", db],
        { stdio: "inherit", env: pgClientEnv(opts.pgBinDir, devPostgresPassword(process.cwd())) },
      )
      process.exit(result.status ?? 0)
    })
}

// ---------------------------------------------------------------------------
// Helper: build PgOptions from config
// ---------------------------------------------------------------------------

/**
 * The cluster `supatype dev` runs for this project: the same binaries, data directory and port.
 *
 * It used to resolve its own: port 5432 whatever the project set, and an override directory
 * without the path normalisation dev applies, so `pg` could manage a different cluster from the
 * one dev started.
 */
async function pgOpts(config: ReturnType<typeof loadConfig>): Promise<PgOptions> {
  const logsDir = join(nativeStateRoot(config), "logs")
  mkdirSync(logsDir, { recursive: true })
  const { resolvePgBinDir } = await import("./dev.js")
  return {
    pgBinDir: await resolvePgBinDir(config),
    dataDir: nativeDataDir(config),
    port: nativeDbPort(config),
    logPath: join(logsDir, "postgres.log"),
  }
}
