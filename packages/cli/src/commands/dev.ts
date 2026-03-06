import type { Command } from "commander"
import { spawnSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { loadConfig } from "../config.js"
import { invokeEngine } from "../engine.js"

const POSTGREST_URL = "http://localhost:3000"
const HEALTH_TIMEOUT_MS = 60_000
const HEALTH_POLL_MS = 2_000

export function registerDev(program: Command): void {
  program
    .command("dev")
    .description(
      "Start local Postgres, PostgREST, and Kong via Docker Compose, then watch for schema changes",
    )
    .option("--no-watch", "Start services but do not watch for schema changes")
    .action(async (opts: { watch: boolean }) => {
      const cwd = process.cwd()

      if (!existsSync(resolve(cwd, "docker-compose.yml"))) {
        console.error(
          "docker-compose.yml not found. Run: supatype init",
        )
        process.exit(1)
      }

      console.log("Starting services...")
      const up = spawnSync(
        "docker",
        ["compose", "up", "-d", "--wait"],
        { cwd, stdio: "inherit" },
      )
      if (up.status !== 0) {
        console.error("docker compose up failed.")
        process.exit(1)
      }

      console.log("Waiting for PostgREST to be ready...")
      await waitForPostgREST()

      console.log("\nServices running:")
      console.log("  Postgres    postgresql://localhost:5432")
      console.log("  PostgREST   http://localhost:3000")
      console.log("  Kong        http://localhost:8000")
      console.log("    REST API  http://localhost:8000/rest/v1/")
      console.log("    GraphQL   http://localhost:8000/graphql/v1\n")

      if (opts.watch) {
        await watchAndPush(cwd)
      }
    })
}

async function waitForPostgREST(): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(POSTGREST_URL, { signal: AbortSignal.timeout(2000) })
      if (res.ok || res.status === 401) return // 401 = JWT required = server up
    } catch {
      // not ready yet
    }
    await sleep(HEALTH_POLL_MS)
  }
  throw new Error(
    `PostgREST did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s.\n` +
      "Check: docker compose logs postgrest",
  )
}

async function watchAndPush(cwd: string): Promise<void> {
  const config = loadConfig(cwd)
  const schemaDir = resolve(cwd, config.schema, "..")

  console.log(`Watching ${schemaDir} for changes... (Ctrl+C to stop)\n`)

  // Initial push on start
  await runPush(cwd)

  const { watch } = await import("node:fs")
  watch(schemaDir, { recursive: true }, (eventType, filename) => {
    if (!filename?.endsWith(".ts")) return
    console.log(`\nChange detected in ${filename}, pushing...`)
    runPush(cwd).catch((e: unknown) =>
      console.error("Push failed:", (e as Error).message),
    )
  })

  // Block forever
  await new Promise<never>(() => undefined)
}

async function runPush(cwd: string): Promise<void> {
  const { loadConfig, loadSchemaAst } = await import("../config.js")
  const config = loadConfig(cwd)
  const ast = loadSchemaAst(config.schema, cwd)
  const result = invokeEngine(
    ["migrate", "--connection", config.connection],
    JSON.stringify(ast),
  )
  if (result.exitCode !== 0) {
    console.error(result.stderr || result.stdout)
    return
  }
  console.log(result.stdout || "Schema up to date.")
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
