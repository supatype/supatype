/**
 * supatype status — show linked target or local dev stack state.
 */
import type { Command } from "commander"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { LOCAL_KONG_HOST_PORT, localKongBaseUrl } from "../local-gateway.js"
import { loadLocalEnvironment, loadProjectLink } from "../link.js"
import { resolveTarget, targetStatus } from "../resolve-target.js"

interface ServiceStatus {
  name: string
  container: string
  status: "running" | "stopped" | "error"
  port?: number
  uptime?: string
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show linked target status or local dev services")
    .option("--env <name>", "Target environment when linked")
    .action(async (opts: { env?: string }) => {
      const cwd = process.cwd()
      const link = loadProjectLink(cwd)
      const localEnv = loadLocalEnvironment(cwd)

      if (link || localEnv) {
        try {
          const target = resolveTarget(cwd, { env: opts.env })
          if (target.mode !== "direct") {
            await printLinkedStatus(target)
            return
          }
        } catch (err) {
          console.error((err as Error).message)
          process.exitCode = 1
          return
        }
      }

      printLocalStackStatus(cwd)
    })
}

async function printLinkedStatus(target: ReturnType<typeof resolveTarget>): Promise<void> {
  console.log(`Target: ${target.mode} (${target.environment})`)
  console.log(`Project: ${target.projectRef}`)
  console.log(`API: ${target.apiBaseUrl}${target.apiPrefix}\n`)

  try {
    const data = (await targetStatus(target)) as Record<string, unknown>
    if (data.functions && Array.isArray(data.functions)) {
      console.log(`Functions (${data.functions.length}):`)
      for (const fn of data.functions as Array<{ name?: string } | string>) {
        const name = typeof fn === "string" ? fn : fn.name
        if (name) console.log(`  • ${name}`)
      }
      console.log()
    }
    if (data.deploymentId) {
      console.log(`Active deployment: ${data.deploymentId}`)
    }
    if (data.controlPlane) {
      console.log(`Control plane: ${data.controlPlane}`)
    }
  } catch (err) {
    console.warn(`Could not fetch remote status: ${(err as Error).message}`)
  }
}

function printLocalStackStatus(cwd: string): void {
  const localEnv = loadLocalEnvironment(cwd)
  const kongPort = localEnv?.kongPort ?? LOCAL_KONG_HOST_PORT

  const services: ServiceStatus[] = [
    { name: "Postgres", container: "supatype-postgres", port: 5432 },
    { name: "PostgREST", container: "supatype-postgrest", port: 3000 },
    { name: "GoTrue", container: "supatype-gotrue", port: 9999 },
    { name: "Kong", container: "supatype-kong", port: kongPort },
    { name: "Control plane", container: "supatype-control-plane" },
    { name: "MinIO", container: "supatype-minio", port: 9000 },
    { name: "Realtime", container: "supatype-realtime", port: 4000 },
    { name: "Studio", container: "supatype-studio", port: 3100 },
  ].map((svc) => {
    const status = getContainerStatus(svc.container)
    const uptime = getContainerUptime(svc.container)
    return { ...svc, status, ...(uptime !== undefined && { uptime }) }
  })

  console.log("Supatype Local Development Stack\n")

  const maxName = Math.max(...services.map((s) => s.name.length))
  for (const svc of services) {
    const icon = svc.status === "running" ? "●" : svc.status === "stopped" ? "○" : "✕"
    const status = svc.status.padEnd(8)
    const port = svc.port ? `:${svc.port}` : ""
    const uptime = svc.uptime ? ` (${svc.uptime})` : ""
    console.log(`  ${icon} ${svc.name.padEnd(maxName)}  ${status}  ${port}${uptime}`)
  }

  const running = services.filter((s) => s.status === "running")
  console.log(`\n${running.length}/${services.length} services running`)

  if (running.length > 0) {
    const apiUrl = localEnv?.apiUrl ?? localKongBaseUrl()
    console.log(`\nAPI URL:    ${apiUrl}`)
    console.log(`Studio:     http://localhost:3100`)
    if (localEnv?.databaseUrl) {
      console.log(`Database:   ${localEnv.databaseUrl}`)
    } else {
      console.log(`Database:   postgresql://supatype_admin:postgres@localhost:5432/postgres`)
    }
  }

  if (existsSync(resolve(cwd, ".supatype/environment.json"))) {
    console.log("\nLocal environment file: .supatype/environment.json")
    console.log("Link remote ops: supatype link --url <api> --token $SERVICE_ROLE_KEY")
  }
}

function getContainerStatus(name: string): "running" | "stopped" | "error" {
  const result = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", name], {
    timeout: 5000,
  })
  const status = result.stdout?.toString().trim()
  if (status === "running") return "running"
  if (result.status !== 0) return "stopped"
  return "error"
}

function getContainerUptime(name: string): string | undefined {
  const result = spawnSync("docker", ["inspect", "--format", "{{.State.StartedAt}}", name], {
    timeout: 5000,
  })
  if (result.status !== 0) return undefined
  const startedAt = result.stdout?.toString().trim()
  if (!startedAt) return undefined

  const started = new Date(startedAt)
  const now = new Date()
  const diffMs = now.getTime() - started.getTime()
  if (diffMs < 0) return undefined

  const hours = Math.floor(diffMs / (1000 * 60 * 60))
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
