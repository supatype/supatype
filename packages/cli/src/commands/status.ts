/**
 * supatype status: show linked target or local stack state.
 */
import type { Command } from "commander"
import { errorMessage } from "../error-message.js"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { composeContext, composeServices } from "../compose-services.js"
import { localKongBaseUrl } from "../local-gateway.js"
import { loadLocalEnvironment, loadProjectLink } from "../link.js"
import { resolveTarget, targetStatus } from "../resolve-target.js"
import { error, info, plain, warn } from "../ui/messages.js"
import { isJsonObject } from "@supatype/shared"

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show linked target status or local stack services")
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
          error(errorMessage(err))
          process.exitCode = 1
          return
        }
      }

      printLocalStackStatus(cwd)
    })
}

async function printLinkedStatus(target: ReturnType<typeof resolveTarget>): Promise<void> {
  info(`Target: ${target.mode} (${target.environment})`)
  info(`Project: ${target.projectRef}`)
  info(`API: ${target.apiBaseUrl}${target.apiPrefix}`)
  plain()

  try {
    const answer = await targetStatus(target)
    const data = isJsonObject(answer) ? answer : {}
    const functions = data["functions"]
    if (Array.isArray(functions)) {
      plain(`Functions (${functions.length}):`)
      for (const fn of functions) {
        const name = typeof fn === "string" ? fn : isJsonObject(fn) ? fn["name"] : undefined
        if (name) plain(`  • ${String(name)}`)
      }
      plain()
    }
    if (data["deploymentId"]) {
      info(`Active deployment: ${String(data["deploymentId"])}`)
    }
    if (data["controlPlane"]) {
      info(`Control plane: ${String(data["controlPlane"])}`)
    }
  } catch (err) {
    warn(`Could not fetch remote status: ${errorMessage(err)}`)
  }
}

/**
 * printLocalStackStatus reports what the stack is actually running.
 *
 * It asks Docker rather than checking a list of container names held here. The
 * list this replaced named containers the compose file does not create, and
 * omitted every one it does, so the command described an eight-service stack
 * that has not existed since those services moved in-process behind
 * supatype-server.
 */
function printLocalStackStatus(cwd: string): void {
  const ctx = composeContext(cwd)
  if (!ctx) {
    plain("Supatype local stack\n")
    info("No generated compose file here.")
    info("Run `supatype self-host compose up` to create the stack, or `supatype dev`,")
    info("which runs the development stack outside Docker.")
    return
  }

  const services = composeServices(ctx)
  plain(`Supatype local stack (${ctx.projectName})\n`)

  if (services.length === 0) {
    info("No containers yet. Start the stack with `supatype self-host compose up`.")
    return
  }

  const width = Math.max(...services.map((svc) => svc.service.length))
  for (const svc of services) {
    const icon = svc.state === "running" ? "●" : svc.state === "exited" ? "○" : "✕"
    const ports = svc.ports ? `  ${svc.ports}` : ""
    plain(`  ${icon} ${svc.service.padEnd(width)}  ${svc.state.padEnd(10)}${ports}`)
  }

  const running = services.filter((svc) => svc.state === "running")
  plain(`\n${running.length}/${services.length} services running`)

  if (running.length > 0) {
    const localEnv = loadLocalEnvironment(cwd)
    plain(`\nAPI URL:    ${localEnv?.apiUrl ?? localKongBaseUrl()}`)
    if (localEnv?.databaseUrl) {
      plain(`Database:   ${localEnv.databaseUrl}`)
    }
  }

  if (existsSync(resolve(cwd, ".supatype/environment.json"))) {
    plain("\nLocal environment file: .supatype/environment.json")
    info("Link remote ops: supatype link --url <api> --token $SERVICE_ROLE_KEY")
  }
}
