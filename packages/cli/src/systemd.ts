/**
 * systemd.ts — generate systemd unit files for self-hosted deployments.
 *
 * Usage:
 *   generateUnits(config, outputDir)
 *   → writes supatype-postgres.service + supatype-server.service to outputDir
 */

import { writeFileSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import type { SupatypeProjectConfig } from "./project-config.js"

export interface SystemdOptions {
  /** Directory where unit files are written. Defaults to .supatype/systemd/. */
  outputDir?: string
  /** User to run services as. Defaults to current user. */
  user?: string
  /** EnvironmentFile path injected into the units. Defaults to project .env. */
  envFile?: string
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate supatype-postgres.service and supatype-server.service.
 *
 * Returns the paths of the written files.
 */
export function generateUnits(
  config: SupatypeProjectConfig,
  projectDir: string,
  opts: SystemdOptions = {},
): { postgres: string; server: string } {
  const outputDir = opts.outputDir ?? resolve(projectDir, ".supatype", "systemd")
  mkdirSync(outputDir, { recursive: true })

  const user = opts.user ?? process.env["USER"] ?? "supatype"
  const envFile = opts.envFile ?? resolve(projectDir, ".env")
  const stateDir = join(homedir(), ".supatype", "projects", config.project.name)

  const postgresPath = join(outputDir, "supatype-postgres.service")
  const serverPath = join(outputDir, "supatype-server.service")

  writeFileSync(postgresPath, postgresUnit(config, stateDir, user, envFile), "utf8")
  writeFileSync(serverPath, serverUnit(config, stateDir, user, envFile), "utf8")

  return { postgres: postgresPath, server: serverPath }
}

// ---------------------------------------------------------------------------
// Unit templates
// ---------------------------------------------------------------------------

function postgresUnit(
  config: SupatypeProjectConfig,
  stateDir: string,
  user: string,
  envFile: string,
): string {
  const dataDir = config.database.data_dir ?? join(stateDir, "data")
  const logDir = join(stateDir, "logs")
  const pgBinDir = `%h/.supatype/cache/postgres/${config.versions.postgres}/bin`

  return `[Unit]
Description=Supatype Postgres (${config.project.name})
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=forking
User=${user}
EnvironmentFile=-${envFile}
ExecStartPre=/bin/mkdir -p ${logDir}
ExecStart=${pgBinDir}/pg_ctl start \\
  -D ${dataDir} \\
  -l ${logDir}/postgres.log \\
  -w \\
  -t 60
ExecStop=${pgBinDir}/pg_ctl stop -D ${dataDir} -m fast
ExecReload=${pgBinDir}/pg_ctl reload -D ${dataDir}
PIDFile=${stateDir}/pid/postgres.pid
Restart=on-failure
RestartSec=5s
TimeoutStartSec=90
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
`
}

function serverUnit(
  config: SupatypeProjectConfig,
  stateDir: string,
  user: string,
  envFile: string,
): string {
  const port = config.server.port ?? 54321
  const serverBin = `%h/.supatype/cache/server/${config.versions.server}/supatype-server`
  const logDir = join(stateDir, "logs")

  const extraArgs: string[] = [`--mode ${config.server.mode}`]
  if (config.server.domain) extraArgs.push(`--domain ${config.server.domain}`)

  return `[Unit]
Description=Supatype Server (${config.project.name})
After=network.target supatype-postgres.service
Requires=supatype-postgres.service
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${user}
EnvironmentFile=-${envFile}
ExecStartPre=/bin/mkdir -p ${logDir}
ExecStart=${serverBin} \\
  --port ${port} \\
  ${extraArgs.join(" \\\n  ")}
PIDFile=${stateDir}/pid/server.pid
StandardOutput=append:${logDir}/server.log
StandardError=append:${logDir}/server.log
Restart=on-failure
RestartSec=5s
TimeoutStartSec=30
TimeoutStopSec=15
KillMode=mixed
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
`
}
