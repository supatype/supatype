/**
 * self-host commands — manage native (non-Docker) self-hosted deployments.
 *
 *   supatype self-host install-service   — install systemd units
 *   supatype self-host serve             — run server in foreground
 *   supatype self-host reload            — SIGHUP the running server
 *   supatype self-host status            — show process / service health
 *   supatype self-host logs              — tail log files
 *   supatype self-host backup            — create pg_dump
 */

import type { Command } from "commander"
import { existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { spawnSync, execFileSync } from "node:child_process"
import { loadConfig } from "../config.js"
import { connectionString } from "../config-toml.js"
import { resolveBinary } from "../binary-cache.js"
import { generateUnits } from "../systemd.js"
import { readPid } from "../process-manager.js"
import { localStorageEnv } from "../local-storage.js"

export function registerSelfHost(program: Command): void {
  const selfHostCmd = program
    .command("self-host")
    .description("Manage native self-hosted deployments")

  // ── install-service ────────────────────────────────────────────────────────

  selfHostCmd
    .command("install-service")
    .description(
      "Generate systemd unit files and (on Linux) install + enable them",
    )
    .option("--output-dir <path>", "Write unit files here instead of /etc/systemd/system/")
    .option("--user <name>", "User to run services as")
    .option("--no-enable", "Generate unit files but do not enable/start them")
    .action(
      async (opts: {
        outputDir?: string
        user?: string
        enable: boolean
      }) => {
        const cwd = process.cwd()
        const config = loadConfig(cwd)

        const systemdDir = opts.outputDir ?? ".supatype/systemd"
        const absSystemdDir = resolve(cwd, systemdDir)

        console.log("Generating systemd unit files...")
        const { postgres, server } = generateUnits(config, cwd, {
          outputDir: absSystemdDir,
          ...(opts.user !== undefined && { user: opts.user }),
        })
        console.log(`  wrote ${postgres}`)
        console.log(`  wrote ${server}`)

        if (!opts.enable) {
          console.log(
            `\nTo install manually:\n` +
            `  sudo cp ${postgres} /etc/systemd/system/\n` +
            `  sudo cp ${server} /etc/systemd/system/\n` +
            `  sudo systemctl daemon-reload\n` +
            `  sudo systemctl enable --now supatype-postgres supatype-server`,
          )
          return
        }

        if (process.platform !== "linux") {
          console.log(
            "\nNote: systemd unit installation is only supported on Linux.\n" +
            `Unit files are at ${absSystemdDir}/`,
          )
          return
        }

        // Install to /etc/systemd/system/
        console.log("\nInstalling to /etc/systemd/system/ (requires sudo)...")
        const units = [
          { src: postgres, dest: "/etc/systemd/system/supatype-postgres.service" },
          { src: server, dest: "/etc/systemd/system/supatype-server.service" },
        ]
        for (const { src, dest } of units) {
          const cp = spawnSync("sudo", ["cp", src, dest], { stdio: "inherit" })
          if (cp.status !== 0) {
            console.error(`Failed to copy ${src} to ${dest}`)
            process.exit(1)
          }
        }

        const daemonReload = spawnSync("sudo", ["systemctl", "daemon-reload"], { stdio: "inherit" })
        if (daemonReload.status !== 0) { process.exit(1) }

        const enable = spawnSync(
          "sudo",
          ["systemctl", "enable", "--now", "supatype-postgres", "supatype-server"],
          { stdio: "inherit" },
        )
        if (enable.status !== 0) { process.exit(1) }

        console.log("\nServices installed and started.")
        console.log("  supatype-postgres.service")
        console.log("  supatype-server.service")
      },
    )

  // ── serve ──────────────────────────────────────────────────────────────────

  selfHostCmd
    .command("serve")
    .description("Start supatype-server in the foreground (for standalone mode)")
    .option("--port <port>", "Override port from config")
    .action(async (opts: { port?: string }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)

      const serverBin = await resolveBinary("server", config)
      const port = opts.port ?? String(config.server.port ?? 54321)

      const args = [
        "--port", port,
        "--mode", config.server.mode,
        ...(config.server.domain ? ["--domain", config.server.domain] : []),
      ]

      const stateDir = join(homedir(), ".supatype", "projects", config.project.name)
      const storageEnv = config.storage?.provider !== "s3" ? localStorageEnv(stateDir) : {}

      console.log(`Starting supatype-server on port ${port}...`)
      const result = spawnSync(serverBin, args, {
        stdio: "inherit",
        cwd,
        env: { ...process.env, ...storageEnv },
      })
      process.exitCode = result.status ?? 1
    })

  // ── reload ─────────────────────────────────────────────────────────────────

  selfHostCmd
    .command("reload")
    .description("Reload the running supatype-server (SIGHUP for config reload)")
    .action(() => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const stateDir = join(homedir(), ".supatype", "projects", config.project.name)
      const pid = readPid(join(stateDir, "pid"), "server")

      if (!pid) {
        // Try systemctl if running as a service
        if (process.platform === "linux") {
          const result = spawnSync("systemctl", ["reload", "supatype-server"], { stdio: "inherit" })
          process.exitCode = result.status ?? 1
          return
        }
        console.error("Server does not appear to be running (no PID file found).")
        process.exitCode = 1
        return
      }

      try {
        process.kill(pid, "SIGHUP")
        console.log(`Sent SIGHUP to supatype-server (pid ${pid}).`)
      } catch (err) {
        console.error(`Failed to signal pid ${pid}:`, (err as Error).message)
        process.exitCode = 1
      }
    })

  // ── status ─────────────────────────────────────────────────────────────────

  selfHostCmd
    .command("status")
    .description("Show running status of supatype services")
    .action(() => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const stateDir = join(homedir(), ".supatype", "projects", config.project.name)

      console.log(`Project: ${config.project.name}\n`)

      if (process.platform === "linux" && existsSync("/run/systemd/system")) {
        // systemd is active
        for (const svc of ["supatype-postgres", "supatype-server"]) {
          const result = spawnSync("systemctl", ["status", "--no-pager", "--lines=0", svc], {
            encoding: "utf8",
          })
          const active = result.stdout?.includes("active (running)") ? "running" : "stopped"
          console.log(`  ${svc}: ${active}`)
        }
      } else {
        // PID file check
        const serverPid = readPid(join(stateDir, "pid"), "server")
        const pgPid = readPid(join(stateDir, "pid"), "postgres")
        console.log(`  postgres:          ${pgPid ? `running (pid ${pgPid})` : "stopped"}`)
        console.log(`  supatype-server:   ${serverPid ? `running (pid ${serverPid})` : "stopped"}`)
      }

      const logDir = join(stateDir, "logs")
      if (existsSync(logDir)) {
        console.log(`\nLogs: ${logDir}`)
      }
    })

  // ── logs ───────────────────────────────────────────────────────────────────

  selfHostCmd
    .command("logs")
    .description("Tail supatype service logs")
    .option("--service <name>", "Show logs for: postgres | server")
    .option("--lines <n>", "Number of lines to show", "50")
    .option("-f, --follow", "Follow log output")
    .action((opts: { service?: string; lines: string; follow?: boolean }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const stateDir = join(homedir(), ".supatype", "projects", config.project.name)
      const logDir = join(stateDir, "logs")

      if (process.platform === "linux" && existsSync("/run/systemd/system")) {
        const args = ["--no-pager", "--lines", opts.lines]
        if (opts.follow) args.push("--follow")
        if (opts.service) args.push(`-u`, `supatype-${opts.service}`)
        else args.push("-u", "supatype-postgres", "-u", "supatype-server")
        spawnSync("journalctl", args, { stdio: "inherit" })
        return
      }

      // File-based logs
      const targets: Array<{ label: string; file: string }> = []
      if (!opts.service || opts.service === "postgres") {
        targets.push({ label: "postgres", file: join(logDir, "postgres.log") })
      }
      if (!opts.service || opts.service === "server") {
        targets.push({ label: "server", file: join(logDir, "server.log") })
      }

      for (const { label, file } of targets) {
        if (!existsSync(file)) {
          console.log(`[${label}] log file not found: ${file}`)
          continue
        }
        if (opts.follow) {
          const tail = spawnSync("tail", ["-f", "-n", opts.lines, file], { stdio: "inherit" })
          process.exitCode = tail.status ?? 0
        } else {
          const n = parseInt(opts.lines, 10)
          const content = readFileSync(file, "utf8")
          const lines = content.split("\n")
          console.log(lines.slice(-n).join("\n"))
        }
      }
    })

  // ── backup ─────────────────────────────────────────────────────────────────

  selfHostCmd
    .command("backup")
    .description("Create a Postgres dump of the project database")
    .option("--output <path>", "Output file path (default: ./backups/backup-<timestamp>.sql.gz)")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action((opts: { output?: string; connection?: string }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const conn = opts.connection ?? connectionString(config)
      const outFile = opts.output ?? resolve(
        cwd,
        "backups",
        `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sql.gz`,
      )

      mkdirSync(resolve(outFile, ".."), { recursive: true })

      console.log(`Backing up database to ${outFile}...`)
      try {
        // pg_dump | gzip > outFile
        execFileSync(
          "sh",
          ["-c", `pg_dump "${conn}" | gzip > "${outFile}"`],
          { stdio: ["ignore", "inherit", "inherit"] },
        )
        console.log("Backup complete.")
      } catch (err) {
        console.error("Backup failed:", (err as Error).message)
        process.exit(1)
      }
    })
}
