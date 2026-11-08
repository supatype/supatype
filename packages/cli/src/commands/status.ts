/**
 * supatype status: show linked target or local stack state.
 */
import type { Command } from "commander"
import { errorMessage, redact } from "../error-message.js"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { composeContext, composeServices } from "../compose-services.js"
import { localPublicApiUrl } from "../local-gateway.js"
import { loadLocalEnvironment, loadProjectLink } from "../link.js"
import { hostDatabaseUrl, resolveTarget, targetStatus } from "../resolve-target.js"
import { error, info, plain, warn } from "../ui/messages.js"
import { isJsonObject } from "@supatype/shared"
import type { SupatypeProjectConfig } from "../config.js"

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
            // The local stack's services follow its functions: only the functions were listed,
            // where the help promised services (issue 79). A remote stack is not this machine's.
            if (target.mode !== "local") return
          }
        } catch (err) {
          error(errorMessage(err))
          process.exitCode = 1
          return
        }
      }

      await printLocalStackStatus(cwd)
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
async function printLocalStackStatus(cwd: string): Promise<void> {
  const ctx = composeContext(cwd)
  if (!ctx) {
    plain("Supatype local stack\n")
    info("No generated compose file here.")
    info("Run `supatype self-host compose up` to create the stack, or `supatype dev`,")
    info("which runs the development stack outside Docker.")
    return
  }

  const services = await composeServices(ctx)
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
    plain(`\nAPI URL:    ${loadLocalEnvironment(cwd)?.apiUrl ?? localPublicApiUrl(cwd)}`)
    const database = ctx.config && hostDatabase(cwd, ctx.config)
    if (database !== undefined) plain(`Database:   ${database}`)
  }

  if (existsSync(resolve(cwd, ".supatype/environment.json"))) {
    plain("\nLocal environment file: .supatype/environment.json")
    info("Link remote ops: supatype link --url <api> --token $SERVICE_ROLE_KEY")
  }
}

/**
 * The database as a program on this machine connects to it, without its password, or undefined
 * when none can be named. Not environment.json's URL: that one is the db container's name inside the
 * stack, and it was printed with the superuser's password in it (issue 80), in the output people
 * paste into an issue.
 */
function hostDatabase(cwd: string, config: SupatypeProjectConfig): string | undefined {
  try {
    return redact(hostDatabaseUrl(cwd, config))
  } catch {
    // DsnNotFound: no database can be named, so the line is left out.
    return undefined
  }
}
