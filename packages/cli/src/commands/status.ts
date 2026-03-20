/**
 * supatype status — show current state of local dev services.
 */
import type { Command } from "commander"
import { spawnSync } from "node:child_process"

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
    .description("Show current state of local dev services")
    .action(() => {
      const services: ServiceStatus[] = [
        { name: "Postgres", container: "supatype-postgres", port: 5432 },
        { name: "PostgREST", container: "supatype-postgrest", port: 3000 },
        { name: "GoTrue", container: "supatype-gotrue", port: 9999 },
        { name: "Kong", container: "supatype-kong", port: 8000 },
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
        console.log(`\nAPI URL:    http://localhost:8000`)
        console.log(`Studio:     http://localhost:3100`)
        console.log(`Database:   postgresql://postgres:postgres@localhost:5432/postgres`)
      }
    })
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
