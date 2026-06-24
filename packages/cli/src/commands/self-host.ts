/**
 * self-host commands — manage self-hosted deployments.
 *
 * Compose-based commands are the default path.
 * Native/systemd commands remain available for bare-metal deployments.
 */

import { Command } from "commander"
import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { spawnSync } from "node:child_process"
import { gzipSync } from "node:zlib"
import { loadConfig } from "../config.js"
import { connectionString } from "../project-config.js"
import { resolveBinary } from "../binary-cache.js"
import { generateUnits } from "../systemd.js"
import { readPid } from "../process-manager.js"
import { localStorageEnv } from "../local-storage.js"
import { composeProjectName, exitComposeFailed, runDockerCompose, writeSelfHostCompose } from "../self-host-compose.js"
import { file, error, info, plain, warn } from "../ui/messages.js"
import { nextSteps } from "../ui/next-steps.js"
import { withSpinner } from "../ui/progress.js"

export function registerSelfHost(program: Command): void {
  const selfHostCmd = program
    .command("self-host")
    .description("Manage self-hosted deployments (Docker Compose only)")

  const composeCmd = selfHostCmd
    .command("compose")
    .description("Manage compose-based self-host runtime")

  composeCmd
    .command("render")
    .description("Render deterministic self-host compose artifacts")
    .action(() => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const out = writeSelfHostCompose(cwd, config)
      file("wrote", out.composePath)
      file("wrote", out.kongPath)
    })

  composeCmd
    .command("up")
    .description("Render and start compose services")
    .option("-d, --detach", "Start in detached mode", true)
    .action(async (opts: { detach?: boolean }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const project = composeProjectName(config.project.name)
      const args = opts.detach ? ["up", "-d"] : ["up"]
      const brand = { intro: "Self-host deployment" }
      const status = await withSpinner("Starting self-host Compose stack", async () => {
        const out = writeSelfHostCompose(cwd, config)
        return runDockerCompose(out.composePath, args, cwd, project, { brand })
      })
      if (status !== 0) {
        exitComposeFailed(status, "Could not start the self-host Compose stack.", brand)
      }
    })

  composeCmd
    .command("down")
    .description("Stop compose services")
    .action(() => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const out = writeSelfHostCompose(cwd, config)
      const brand = { intro: "Self-host deployment" }
      const status = runDockerCompose(
        out.composePath,
        ["down"],
        cwd,
        composeProjectName(config.project.name),
        { brand },
      )
      if (status !== 0) {
        exitComposeFailed(status, "Could not stop the self-host Compose stack.", brand)
      }
    })

  composeCmd
    .command("status")
    .description("Show compose service status")
    .action(() => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const out = writeSelfHostCompose(cwd, config)
      process.exitCode = runDockerCompose(
        out.composePath,
        ["ps"],
        cwd,
        composeProjectName(config.project.name),
        { brand: { intro: "Self-host deployment" } },
      )
    })

  composeCmd
    .command("logs")
    .description("Tail compose logs")
    .option("--service <name>", "Filter to one service")
    .option("-f, --follow", "Follow log output", true)
    .action((opts: { service?: string; follow?: boolean }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const out = writeSelfHostCompose(cwd, config)
      const args = ["logs"]
      if (opts.follow) args.push("-f")
      if (opts.service) args.push(opts.service)
      process.exitCode = runDockerCompose(
        out.composePath,
        args,
        cwd,
        composeProjectName(config.project.name),
        { brand: { intro: "Self-host deployment" } },
      )
    })

  // ── Native/systemd helpers (hidden; compose is the default self-host path) ─────

  const legacyCmd = new Command("native")
  selfHostCmd.addCommand(legacyCmd, { hidden: true })

  legacyCmd
    .command(
      "install-service",
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
        logNativeHint("install-service")
        const cwd = process.cwd()
        const config = loadConfig(cwd)

        const systemdDir = opts.outputDir ?? ".supatype/systemd"
        const absSystemdDir = resolve(cwd, systemdDir)

        info("Generating systemd unit files...")
        const { postgres, server } = generateUnits(config, cwd, {
          outputDir: absSystemdDir,
          ...(opts.user !== undefined && { user: opts.user }),
        })
        plain(`  wrote ${postgres}`)
        plain(`  wrote ${server}`)

        if (!opts.enable) {
          nextSteps("To install manually:", [
            `sudo cp ${postgres} /etc/systemd/system/`,
            `sudo cp ${server} /etc/systemd/system/`,
            "sudo systemctl daemon-reload",
            "sudo systemctl enable --now supatype-postgres supatype-server",
          ])
          return
        }

        if (process.platform !== "linux") {
          info(
            "systemd unit installation is only supported on Linux. " +
            `Unit files are at ${absSystemdDir}/`,
          )
          return
        }

        // Install to /etc/systemd/system/
        info("Installing to /etc/systemd/system/ (requires sudo)...")
        const units = [
          { src: postgres, dest: "/etc/systemd/system/supatype-postgres.service" },
          { src: server, dest: "/etc/systemd/system/supatype-server.service" },
        ]
        for (const { src, dest } of units) {
          const cp = spawnSync("sudo", ["cp", src, dest], { stdio: "inherit" })
          if (cp.status !== 0) {
            error(`Failed to copy ${src} to ${dest}`)
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

        info("Services installed and started.")
        plain("  supatype-postgres.service")
        plain("  supatype-server.service")
      },
    )

  // ── serve ──────────────────────────────────────────────────────────────────

  legacyCmd
    .command("serve", "Start supatype-server in the foreground (for standalone mode)")
    .option("--port <port>", "Override port from config")
    .action(async (opts: { port?: string }) => {
      logNativeHint("serve")
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

      info(`Starting supatype-server on port ${port}...`)
      const result = spawnSync(serverBin, args, {
        stdio: "inherit",
        cwd,
        env: { ...process.env, ...storageEnv },
      })
      process.exitCode = result.status ?? 1
    })

  // ── reload ─────────────────────────────────────────────────────────────────

  legacyCmd
    .command("reload", "Reload the running supatype-server (SIGHUP for config reload)")
    .action(() => {
      logNativeHint("reload")
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
        error("Server does not appear to be running (no PID file found).")
        process.exitCode = 1
        return
      }

      try {
        process.kill(pid, "SIGHUP")
        info(`Sent SIGHUP to supatype-server (pid ${pid}).`)
      } catch (err) {
        error(`Failed to signal pid ${pid}: ${(err as Error).message}`)
        process.exitCode = 1
      }
    })

  // ── status ─────────────────────────────────────────────────────────────────

  legacyCmd
    .command("status", "Show running status of supatype services")
    .action(() => {
      logNativeHint("status")
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const stateDir = join(homedir(), ".supatype", "projects", config.project.name)

      plain(`Project: ${config.project.name}\n`)

      if (process.platform === "linux" && existsSync("/run/systemd/system")) {
        // systemd is active
        for (const svc of ["supatype-postgres", "supatype-server"]) {
          const result = spawnSync("systemctl", ["status", "--no-pager", "--lines=0", svc], {
            encoding: "utf8",
          })
          const active = result.stdout?.includes("active (running)") ? "running" : "stopped"
          plain(`  ${svc}: ${active}`)
        }
      } else {
        // PID file check
        const serverPid = readPid(join(stateDir, "pid"), "server")
        const pgPid = readPid(join(stateDir, "pid"), "postgres")
        plain(`  postgres:          ${pgPid ? `running (pid ${pgPid})` : "stopped"}`)
        plain(`  supatype-server:   ${serverPid ? `running (pid ${serverPid})` : "stopped"}`)
      }

      const logDir = join(stateDir, "logs")
      if (existsSync(logDir)) {
        plain(`\nLogs: ${logDir}`)
      }
    })

  // ── logs ───────────────────────────────────────────────────────────────────

  selfHostCmd
    .command("logs", "Tail supatype service logs", { hidden: true })
    .option("--service <name>", "Show logs for: postgres | server")
    .option("--lines <n>", "Number of lines to show", "50")
    .option("-f, --follow", "Follow log output")
    .action((opts: { service?: string; lines: string; follow?: boolean }) => {
      logNativeHint("logs")
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
          plain(`[${label}] log file not found: ${file}`)
          continue
        }
        if (opts.follow) {
          const tail = spawnSync("tail", ["-f", "-n", opts.lines, file], { stdio: "inherit" })
          process.exitCode = tail.status ?? 0
        } else {
          const n = parseInt(opts.lines, 10)
          const content = readFileSync(file, "utf8")
          const lines = content.split("\n")
          plain(lines.slice(-n).join("\n"))
        }
      }
    })

  // ── backup ─────────────────────────────────────────────────────────────────

  legacyCmd
    .command("backup", "Create a Postgres dump of the project database")
    .option("--output <path>", "Output file path (default: ./backups/backup-<timestamp>.sql.gz)")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action((opts: { output?: string; connection?: string }) => {
      logNativeHint("backup")
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const conn = opts.connection ?? connectionString(config)
      const outFile = opts.output ?? resolve(
        cwd,
        "backups",
        `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sql.gz`,
      )

      mkdirSync(resolve(outFile, ".."), { recursive: true })

      info(`Backing up database to ${outFile}...`)
      try {
        // Avoid shell interpolation of user-supplied values.
        const pgDump = spawnSync("pg_dump", [conn], {
          stdio: ["ignore", "pipe", "pipe"],
        })
        if (pgDump.status !== 0) {
          const stderr = pgDump.stderr?.toString("utf8") ?? ""
          throw new Error(stderr.trim() || "pg_dump failed")
        }

        const compressed = gzipSync(pgDump.stdout)
        writeFileSync(outFile, compressed)
        info("Backup complete.")
      } catch (err) {
        error(`Backup failed: ${(err as Error).message}`)
        process.exit(1)
      }
    })
}

function logNativeHint(cmd: string): void {
  warn(
    `self-host native ${cmd}: Docker Compose is the default path. ` +
      "Use `supatype self-host compose` unless you need bare-metal systemd/binaries.",
  )
}
