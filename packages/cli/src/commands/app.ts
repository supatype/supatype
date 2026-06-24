import type { Command } from "commander"
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { localKongBaseUrl } from "../local-gateway.js"
import { updateAppConfigInProject } from "../app-config.js"
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
    .option("--dockerfile <path>", "(deprecated) ignored — use supatype.config.ts")
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

function addStaticApp(cwd: string, staticDir: string): void {
  const abs = resolve(cwd, staticDir)
  if (!existsSync(abs)) {
    mkdirSync(abs, { recursive: true })
    file("created", `${staticDir}/`)
  }
  try {
    const configPath = updateAppConfigInProject(cwd, { mode: "static", staticDir })
    file("updated", configPath)
    info(`Static app directory: ${staticDir}`)
    nextSteps("Build your frontend, then:", [
      "supatype self-host compose render",
      "supatype self-host compose up -d",
      `App URL: ${localKongBaseUrl()}/`,
    ])
  } catch (err) {
    error((err as Error).message)
    process.exit(1)
  }
}

function addProxyApp(cwd: string, port: string, upstream?: string): void {
  const upstreamUrl = upstream?.trim() || `http://localhost:${port}`
  try {
    const configPath = updateAppConfigInProject(cwd, { mode: "proxy", upstream: upstreamUrl })
    file("updated", configPath)
    info(`Forwarding to ${upstreamUrl} — app at ${localKongBaseUrl()}/`)
    nextSteps("Next:", ["supatype self-host compose render"])
  } catch (err) {
    error((err as Error).message)
    process.exit(1)
  }
}

function removeApp(cwd: string): void {
  try {
    const configPath = updateAppConfigInProject(cwd, { mode: "none" })
    file("updated", configPath)
    info("App routing disabled (app.mode=none).")
  } catch (err) {
    error((err as Error).message)
    process.exit(1)
  }
}
