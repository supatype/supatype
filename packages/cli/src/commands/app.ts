import type { Command } from "commander"
import { localKongBaseUrl } from "../local-gateway.js"
import { updateAppConfigInProject } from "../app-config.js"

export function registerApp(program: Command): void {
  const appCmd = program
    .command("app")
    .description("Manage application routing intent in supatype.config.ts")

  appCmd
    .command("add")
    .description("Set app.mode=proxy and route / to your app upstream")
    .option("--dockerfile <path>", "Path to your Dockerfile", "./Dockerfile")
    .option("--port <port>", "Port your app listens on", "3000")
    .option("--upstream <url>", "Explicit upstream URL (defaults to localhost:<port>)")
    .action((opts: { dockerfile: string; port: string; upstream?: string }) => {
      addApp(process.cwd(), opts.port, opts.upstream)
    })

  appCmd
    .command("remove")
    .description("Set app.mode=none in supatype.config.ts")
    .action(() => {
      removeApp(process.cwd())
    })
}

// ─── Implementation ───────────────────────────────────────────────────────────

function addApp(cwd: string, port: string, upstream?: string): void {
  console.warn(
    "[supatype] `app add --dockerfile` is deprecated. " +
      "App onboarding is now config-first via supatype.config.ts.",
  )
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
