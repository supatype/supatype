import type { Command } from "commander"
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { localKongBaseUrl } from "../local-gateway.js"
import { updateAppConfigInProject } from "../app-config.js"

export function registerApp(program: Command): void {
  const appCmd = program
    .command("app")
    .description("Manage application routing intent in supatype.config.ts")

  appCmd
    .command("add [dir]")
    .description("Configure app routing: --static for a built site, or proxy to a dev server")
    .option("--static", "Serve a static directory at / (default: ./public, or [dir] argument)")
    .option("--port <port>", "Port your app listens on (proxy mode)", "3000")
    .option("--upstream <url>", "Explicit upstream URL (proxy mode; defaults to localhost:<port>)")
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
          console.warn("[supatype] --dockerfile is deprecated and ignored.")
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
    console.log(`  created  ${staticDir}/`)
  }
  try {
    const configPath = updateAppConfigInProject(cwd, { mode: "static", staticDir })
    console.log(`  updated  ${configPath}`)
    console.log(`\nStatic app directory: ${staticDir}`)
    console.log(`Build your frontend into ${staticDir}/, then:`)
    console.log(`  supatype self-host compose render`)
    console.log(`  supatype self-host compose up -d`)
    console.log(`\nYour app will be served at ${localKongBaseUrl()}/\n`)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}

function addProxyApp(cwd: string, port: string, upstream?: string): void {
  const upstreamUrl = upstream?.trim() || `http://localhost:${port}`
  try {
    const configPath = updateAppConfigInProject(cwd, { mode: "proxy", upstream: upstreamUrl })
    console.log(`  updated  ${configPath}`)
    console.log(`\nApp upstream set to ${upstreamUrl}. The app will be available at ${localKongBaseUrl()}/\n`)
    console.log("Run: supatype self-host compose render")
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}

function removeApp(cwd: string): void {
  try {
    const configPath = updateAppConfigInProject(cwd, { mode: "none" })
    console.log(`  updated  ${configPath}`)
    console.log("\nApp routing disabled (app.mode=none).\n")
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}
