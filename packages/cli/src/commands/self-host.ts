/**
 * self-host commands: manage self-hosted deployments.
 *
 * Compose-based commands are the default path.
 * Native/systemd commands remain available for bare-metal deployments.
 */

import { Command } from "commander"
import { errorMessage } from "../error-message.js"
import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { spawnSync } from "node:child_process"
import { gzipSync } from "node:zlib"
import { loadConfig } from "../config.js"
import { connectionString } from "../project-config.js"
import { devPostgresPassword } from "../local-secrets.js"
import { splitPassword } from "../host-database.js"
import { fillMissingKeys, resolveSecret } from "./keys.js"
import { requireUsableJwtSecret } from "../jwt-secret-length.js"
import { requireUrlSafeComposePasswords } from "../url-safe-passwords.js"
import { resolveBinary } from "../binary-cache.js"
import { generateUnits } from "../systemd.js"
import { readPid } from "../process-manager.js"
import { localStorageEnv } from "../local-storage.js"
import { composeProjectName, exitComposeFailed, runDockerCompose, writeSelfHostCompose } from "../self-host-compose.js"
import { composeRenderOptions } from "../compose-render-mode.js"
import { databaseUrlSyncMessage, syncDatabaseUrlPort } from "../db-port.js"
import { warnProjectAuthProviderSecrets } from "../auth-providers.js"
import { file, error, info, plain, warn } from "../ui/messages.js"
import { nextSteps } from "../ui/next-steps.js"
import { confirm } from "../ui/confirm.js"
import { isInteractive } from "../ui/interactive.js"
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
      requireUrlSafeComposePasswords(cwd, config)
      warnProjectAuthProviderSecrets(cwd, config)
      const out = writeSelfHostCompose(cwd, config, composeRenderOptions(cwd, config.project.name))
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
      requireUrlSafeComposePasswords(cwd, config)
      const project = composeProjectName(config.project.name)
      const args = opts.detach ? ["up", "-d"] : ["up"]
      // A missing secret is compose's to report; a short one only PostgREST would notice.
      const secret = resolveSecret(cwd)
      if (secret !== undefined) requireUsableJwtSecret(secret)
      // A .env copied from the template arrives with both keys blank, and the
      // server will not serve without a service role key outside dev mode.
      // Only blanks are filled: reissuing a key an operator is already using
      // would lock out every client holding the old one.
      const filled = fillMissingKeys(cwd)
      if (filled.length > 0) {
        console.log(`[supatype] Minted ${filled.join(" and ")} in .env from JWT_SECRET.`)
      }
      // Before the spinner, so the warning is not drawn over.
      warnProjectAuthProviderSecrets(cwd, config)
      const renderOptions = composeRenderOptions(cwd, config.project.name)
      // As a push does: a stack started here and never pushed kept whatever DATABASE_URL .env had,
      // which after a `supatype dev` was the dev database, so seed and admin reached that one.
      const dbPort = syncDatabaseUrlPort(cwd, renderOptions.devLocal)
      if (dbPort !== null) console.log(`[supatype] ${databaseUrlSyncMessage(dbPort)}`)
      const status = await withSpinner("Starting self-host Compose stack", async () => {
        const out = writeSelfHostCompose(cwd, config, renderOptions)
        return runDockerCompose(out.composePath, args, cwd, project, { brand: SELF_HOST_BRAND })
      })
      if (status !== 0) {
        exitComposeFailed(status, "Could not start the self-host Compose stack.", SELF_HOST_BRAND)
      }
    })

  composeCmd
    .command("down")
    .description("Stop compose services (volumes are kept unless --volumes)")
    .option("--volumes", "Also remove the stack's volumes: the database and stored files")
    .option("-y, --yes", "Remove the volumes without asking")
    .action(composeDown)

  // Recreated rather than `docker compose restart`, which keeps the container as it was created:
  // a changed .env or config would not reach it, and that is what a restart is usually for.
  // Through `up`, so a Kong in front of a recreated service is reloaded onto its new address.
  composeCmd
    .command("restart <service>")
    .description("Recreate one service with the current config and .env, leaving the others running")
    .action((service: string) => {
      const status = renderAndRunCompose(["up", "-d", "--force-recreate", "--no-deps", service])
      if (status !== 0) {
        exitComposeFailed(status, `Could not restart ${service}.`, SELF_HOST_BRAND)
      }
    })

  composeCmd
    .command("status")
    .description("Show compose service status")
    .action(() => {
      process.exitCode = renderAndRunCompose(["ps"])
    })

  composeCmd
    .command("logs")
    .description("Tail compose logs")
    .option("--service <name>", "Filter to one service")
    .option("-f, --follow", "Follow log output", true)
    .action((opts: { service?: string; follow?: boolean }) => {
      const args = ["logs"]
      if (opts.follow) args.push("-f")
      if (opts.service) args.push(opts.service)
      process.exitCode = renderAndRunCompose(args)
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
        error(`Failed to signal pid ${pid}: ${errorMessage(err)}`)
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
      const conn = opts.connection ?? connectionString(config, devPostgresPassword(cwd), cwd)
      const outFile = opts.output ?? resolve(
        cwd,
        "backups",
        `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sql.gz`,
      )

      mkdirSync(resolve(outFile, ".."), { recursive: true })

      info(`Backing up database to ${outFile}...`)
      try {
        // Avoid shell interpolation of user-supplied values. The password goes in the
        // environment, not on pg_dump's command line, where the process list would show it.
        const { dsn, password } = splitPassword(conn)
        const pgDump = spawnSync("pg_dump", [dsn], {
          stdio: ["ignore", "pipe", "pipe"],
          env: password === undefined ? process.env : { ...process.env, PGPASSWORD: password },
        })
        if (pgDump.status !== 0) {
          const stderr = pgDump.stderr?.toString("utf8") ?? ""
          throw new Error(stderr.trim() || "pg_dump failed")
        }

        const compressed = gzipSync(pgDump.stdout)
        writeFileSync(outFile, compressed)
        info("Backup complete.")
      } catch (err) {
        error(`Backup failed: ${errorMessage(err)}`)
        process.exit(1)
      }
    })
}

const SELF_HOST_BRAND = { intro: "Self-host deployment" }

/**
 * Render the compose file from the current config, then run `args` against this project's stack.
 * Rendered first every time, so the file never names a stale host path or a config that changed.
 */
/**
 * `self-host compose down`. The volumes hold the database and every stored file, so removing them
 * is asked for by name and confirmed; a plain `down` says they were kept, since starting over used
 * to mean finding them with `docker volume ls`.
 */
async function composeDown(opts: { volumes?: boolean; yes?: boolean }): Promise<void> {
  if (opts.volumes === true && opts.yes !== true && !(await confirmVolumeRemoval())) {
    plain("Nothing stopped and nothing removed.")
    return
  }
  const status = renderAndRunCompose(opts.volumes === true ? ["down", "--volumes"] : ["down"])
  if (status !== 0) {
    exitComposeFailed(status, "Could not stop the self-host Compose stack.", SELF_HOST_BRAND)
  }
  info(
    opts.volumes === true
      ? "Stopped the stack and removed its volumes: the database and stored files are gone."
      : "Stopped the stack. Its volumes (the database and stored files) were kept; " +
          "`supatype self-host compose down --volumes` removes them.",
  )
}

/** Asked, never assumed: without a terminal to ask on, `--yes` is the only way through. */
async function confirmVolumeRemoval(): Promise<boolean> {
  if (!isInteractive()) {
    error("Removing the volumes deletes the database and stored files. Pass --yes to confirm.")
    process.exitCode = 1
    return false
  }
  return confirm("Remove the volumes too? This deletes the database and every stored file.", {
    default: false,
  })
}

function renderAndRunCompose(args: string[]): number {
  const cwd = process.cwd()
  const config = loadConfig(cwd)
  requireUrlSafeComposePasswords(cwd, config)
  const out = writeSelfHostCompose(cwd, config, composeRenderOptions(cwd, config.project.name))
  return runDockerCompose(out.composePath, args, cwd, composeProjectName(config.project.name), {
    brand: SELF_HOST_BRAND,
  })
}

function logNativeHint(cmd: string): void {
  warn(
    `self-host native ${cmd}: Docker Compose is the default path. ` +
      "Use `supatype self-host compose` unless you need bare-metal systemd/binaries.",
  )
}
