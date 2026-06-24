import type { Command } from "commander"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { loadProjectLink, migrateLegacyLinkFiles } from "../link.js"
import { targetFetch } from "../target-client.js"
import { registerEnvs, registerLinkOptions, runLinkAction } from "./link-helpers.js"
import { resolveTarget, targetSchemaPush, schemaPgSchema } from "../resolve-target.js"
import { loadConfig, loadSchemaAst } from "../config.js"
import { schemaPathFromProject } from "../project-config.js"
import { error, info, plain } from "../ui/messages.js"
import { nextSteps } from "../ui/next-steps.js"

interface CloudConfig {
  apiUrl: string
  token: string
  projectSlug?: string
  orgId?: string | undefined
}

/** @deprecated Prefer loadProjectLink */
export function loadCloudConfig(cwd: string): CloudConfig | null {
  migrateLegacyLinkFiles(cwd)
  const link = loadProjectLink(cwd)
  if (!link || link.kind !== "cloud") return null
  const legacyPath = resolve(cwd, ".supatype/cloud.json")
  if (existsSync(legacyPath)) {
    return JSON.parse(readFileSync(legacyPath, "utf8")) as CloudConfig
  }
  return {
    apiUrl: link.cloudApiUrl ?? "https://api.supatype.com",
    token: link.token ?? "",
    projectSlug: link.projectRef,
    ...(link.orgId !== undefined ? { orgId: link.orgId } : {}),
  }
}

function saveCloudConfig(cwd: string, config: CloudConfig): void {
  const dir = resolve(cwd, ".supatype")
  if (!existsSync(dir)) {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs")
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(resolve(cwd, ".supatype/cloud.json"), JSON.stringify(config, null, 2) + "\n", "utf8")
}

async function cloudFetch<T>(config: CloudConfig, method: string, path: string, body?: unknown): Promise<T> {
  return targetFetch<T>(config.apiUrl, "/api/v1", {
    method,
    path,
    body,
    token: config.token,
    orgId: config.orgId,
  })
}

export function isCloudLinked(cwd: string): boolean {
  migrateLegacyLinkFiles(cwd)
  const link = loadProjectLink(cwd)
  return Boolean(link?.kind === "cloud" && link.projectRef && link.token)
}

export async function pushSchemaToLinkedProject(
  cwd: string,
  opts?: { force?: boolean; env?: string },
): Promise<void> {
  const config = loadConfig(cwd)
  const target = resolveTarget(cwd, { env: opts?.env })
  if (target.mode !== "cloud") {
    error("Not linked to a cloud project. Run: supatype link --project <slug>")
    process.exit(1)
  }

  const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)
  info(`Pushing schema to ${target.mode} project ${target.projectRef} (${target.environment})...`)

  const result = await targetSchemaPush(target, ast, {
    force: opts?.force ?? true,
    schema: schemaPgSchema(cwd),
  })

  info((result as { message?: string }).message ?? "Schema push completed.")
}

export async function deploySchemaToLinkedProject(cwd: string, environment: string): Promise<void> {
  await pushSchemaToLinkedProject(cwd, { force: true, env: environment })
}

export function registerCloud(program: Command): void {
  registerEnvs(program)

  const linkCmd = program
    .command("link")
    .description("Link this project to cloud or self-host (unified .supatype/link.json)")
  registerLinkOptions(linkCmd)
  linkCmd.action(async (opts: {
    project?: string
    url?: string
    apiUrl: string
    token?: string
    serviceRoleKey?: string
    env?: string
    fixGitignore?: boolean
  }) => {
    await runLinkAction(opts)
  })

  const projectsCmd = program
    .command("projects")
    .description("Manage cloud projects")

  projectsCmd
    .command("list")
    .description("List all projects in your organisation")
    .action(async () => {
      const config = getCloudConfigOrExit()

      const projects = await cloudFetch<Array<{
        name: string; slug: string; tier: string; region: string; status: string
      }>>(config, "GET", "/projects")

      if (projects.length === 0) {
        info("No projects. Create one with: supatype projects create <name>")
        return
      }

      plain("\n  Name                    Slug                     Tier    Region    Status")
      plain("  " + "─".repeat(80))
      for (const p of projects) {
        plain(
          `  ${p.name.padEnd(24)}${p.slug.padEnd(25)}${p.tier.padEnd(8)}${p.region.padEnd(10)}${p.status}`,
        )
      }
      plain()
    })

  projectsCmd
    .command("create <name>")
    .description("Create a new project")
    .option("--tier <tier>", "Project tier (free, pro, team)", "free")
    .option("--region <region>", "Region (eu-fsn, eu-nbg, eu-hel)", "eu-fsn")
    .action(async (name: string, opts: { tier: string; region: string }) => {
      const config = getCloudConfigOrExit()

      info(`Creating project "${name}" (${opts.tier}, ${opts.region})...`)

      const project = await cloudFetch<{ slug: string; name: string; status: string }>(
        config, "POST", "/projects",
        { name, tier: opts.tier, region: opts.region },
      )

      info(`Project created: ${project.name} (${project.slug})`)
      info(`Status: ${project.status}`)
      nextSteps("To link this project:", [`supatype link --project ${project.slug}`])
    })

  projectsCmd
    .command("pause <slug>")
    .description("Pause a project")
    .action(async (slug: string) => {
      const config = getCloudConfigOrExit()
      await cloudFetch(config, "POST", `/projects/${slug}/pause`)
      info(`Project ${slug} paused.`)
    })

  projectsCmd
    .command("resume <slug>")
    .description("Resume a paused project")
    .action(async (slug: string) => {
      const config = getCloudConfigOrExit()
      await cloudFetch(config, "POST", `/projects/${slug}/resume`)
      info(`Project ${slug} resumed.`)
    })

  const domainsCmd = program
    .command("domains")
    .description("Manage custom domains for a project")

  domainsCmd
    .command("list")
    .description("List domains for the linked project")
    .action(async () => {
      const config = getCloudConfigOrExit()
      if (!config.projectSlug) {
        error("Not linked to a project. Run: supatype link")
        process.exit(1)
      }

      const domains = await cloudFetch<Array<{
        domain: string; status: string; cnameTarget: string; sslExpiresAt: string | null
      }>>(config, "GET", `/projects/${config.projectSlug}/domains`)

      if (domains.length === 0) {
        info("No custom domains configured.")
        return
      }

      plain("\n  Domain                          Status               CNAME Target")
      plain("  " + "─".repeat(80))
      for (const d of domains) {
        plain(
          `  ${d.domain.padEnd(34)}${d.status.padEnd(21)}${d.cnameTarget}`,
        )
      }
      plain()
    })

  domainsCmd
    .command("add <domain>")
    .description("Add a custom domain")
    .action(async (domain: string) => {
      const config = getCloudConfigOrExit()
      if (!config.projectSlug) {
        error("Not linked to a project. Run: supatype link")
        process.exit(1)
      }

      const result = await cloudFetch<{ domain: string; cnameTarget: string; instructions: string }>(
        config, "POST", `/projects/${config.projectSlug}/domains`,
        { domain },
      )

      info(`Domain added: ${result.domain}`)
      plain(`\n${result.instructions}`)
      info(`After adding the CNAME record, verify with: supatype domains verify ${domain}`)
    })

  domainsCmd
    .command("remove <domainId>")
    .description("Remove a custom domain")
    .action(async (domainId: string) => {
      const config = getCloudConfigOrExit()
      if (!config.projectSlug) {
        error("Not linked to a project. Run: supatype link")
        process.exit(1)
      }

      await cloudFetch(config, "DELETE", `/projects/${config.projectSlug}/domains/${domainId}`)
      info("Domain removed.")
    })

  domainsCmd
    .command("verify <domainId>")
    .description("Verify CNAME and provision SSL for a domain")
    .action(async (domainId: string) => {
      const config = getCloudConfigOrExit()
      if (!config.projectSlug) {
        error("Not linked to a project. Run: supatype link")
        process.exit(1)
      }

      const result = await cloudFetch<{ domain: string; status: string }>(
        config, "POST", `/projects/${config.projectSlug}/domains/${domainId}/verify`,
      )

      info(`Domain ${result.domain}: ${result.status}`)
    })
}

function getCloudConfigOrExit(): CloudConfig {
  const cwd = process.cwd()
  let config = loadCloudConfig(cwd)
  if (!config) {
    const token =
      process.env["SUPATYPE_ACCESS_TOKEN"] ??
      process.env["SUPATYPE_TOKEN"]
    const apiUrl = process.env["SUPATYPE_API_URL"] ?? "https://api.supatype.com"
    if (!token) {
      error("Not connected to Supatype Cloud. Run: supatype link, or set SUPATYPE_ACCESS_TOKEN.")
      process.exit(1)
    }
    config = { apiUrl, token }
  }
  return config
}
