import type { Command } from "commander"
import { errorMessage } from "../error-message.js"
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { localPublicApiUrl } from "../local-gateway.js"
import { updateAppConfigInProject } from "../app-config.js"
import { loadConfig } from "../config.js"
import { enterLocalStack } from "../dev-session-lock.js"
import { error, file, info, warn } from "../ui/messages.js"
import { nextSteps } from "../ui/next-steps.js"

export function registerApp(program: Command): void {
  const appCmd = program
    .command("app")
    .description("Manage application routing intent in supatype.config.ts")

  appCmd
    .command("add [dir]")
    .description("Configure app routing: --static for a built site, or proxy to a dev server")
    .option("--static", "Serve a static directory at / (default: ./public, or [dir] argument)")
    .option("--port <port>", "Port your app listens on (proxy mode)", "3000")
    .option("--upstream <url>", "URL of your running dev server (proxy mode; defaults to localhost:<port>)")
    .option("--dockerfile <path>", "(deprecated) ignored, use supatype.config.ts")
    .action(
      (
        dir: string | undefined,
        opts: {
          static?: boolean
          port: string
          upstream?: string
          dockerfile?: string
        },
      ) => {
        if (opts.static) {
          addStaticApp(process.cwd(), resolveStaticDir(dir))
          return
        }
        if (opts.dockerfile) {
          warn("--dockerfile is deprecated and ignored.")
        }
        addProxyApp(process.cwd(), opts.port, opts.upstream)
      },
    )

  appCmd
    .command("remove")
    .description("Set app.mode=none in supatype.config.ts")
    .action(() => {
      removeApp(process.cwd())
    })
}

// ─── Implementation ───────────────────────────────────────────────────────────

function resolveStaticDir(dir?: string): string {
  const trimmed = dir?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : "./public"
}

// The app's address is found before anything is written: finding it enters the local stack, which
// can refuse this shell's ports, and a refusal left the config written and the directory made
// (0.9.2 round 5, S-2).
function addStaticApp(cwd: string, staticDir: string): void {
  const appUrl = localAppUrl(cwd)
  const abs = resolve(cwd, staticDir)
  if (!existsSync(abs)) {
    mkdirSync(abs, { recursive: true })
    file("created", `${staticDir}/`)
  }
  try {
    const configPath = updateAppConfigInProject(cwd, { mode: "static", staticDir })
    file("updated", configPath)
    info(`Static app directory: ${staticDir}`)
    nextSteps("Build your frontend, then:", [...applySteps(cwd), `App URL: ${appUrl}`])
  } catch (err) {
    error(errorMessage(err))
    process.exit(1)
  }
}

function addProxyApp(cwd: string, port: string, upstream?: string): void {
  const upstreamUrl = upstream?.trim() || `http://localhost:${port}`
  const appUrl = localAppUrl(cwd)
  try {
    const configPath = updateAppConfigInProject(cwd, { mode: "proxy", upstream: upstreamUrl })
    file("updated", configPath)
    info(`Forwarding to ${upstreamUrl}: app at ${appUrl}`)
    nextSteps("Next:", applySteps(cwd))
  } catch (err) {
    error(errorMessage(err))
    process.exit(1)
  }
}

function removeApp(cwd: string): void {
  try {
    const configPath = updateAppConfigInProject(cwd, { mode: "none" })
    file("updated", configPath)
    info("App routing disabled (app.mode=none).")
    nextSteps("Next:", applySteps(cwd))
  } catch (err) {
    error(errorMessage(err))
    process.exit(1)
  }
}

/**
 * How the changed routing reaches the running stack. A dev project (`server.mode: "dev"`, the merged
 * config `supatype dev` reads) is served by `supatype dev`, which keeps the old app until it
 * restarts; a self-hosted one is brought up through compose, whose `up` renders the compose file
 * from the config first.
 */
function applySteps(cwd: string): string[] {
  if (projectServerMode(cwd) === "dev") {
    return ["Restart `supatype dev`: a running dev stack keeps serving the old app until it restarts."]
  }
  return ["supatype self-host compose up -d"]
}

/** The project's server mode, or undefined when the config cannot be read (the write above still stands). */
function projectServerMode(cwd: string): string | undefined {
  try {
    return loadConfig(cwd).server.mode
  } catch {
    return undefined
  }
}

/**
 * Where the local stack serves the app: on a running dev session's gateway when one runs in this
 * folder, which a port its shell gave keeps out of `.env`. A config that cannot be read names no
 * stack to enter, and the address `.env` gives stands.
 */
function localAppUrl(cwd: string): string {
  try {
    enterLocalStack(cwd, loadConfig(cwd).project.name)
  } catch {
    // Nothing entered: the address below is `.env`'s.
  }
  return `${localPublicApiUrl(cwd)}/`
}
