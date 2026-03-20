import type { Command } from "commander"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface } from "node:readline"

interface CloudConfig {
  apiUrl: string
  token: string
  projectSlug?: string
}

function loadCloudConfig(cwd: string): CloudConfig | null {
  const configPath = resolve(cwd, ".supatype/cloud.json")
  if (!existsSync(configPath)) return null
  return JSON.parse(readFileSync(configPath, "utf8")) as CloudConfig
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
  const res = await fetch(`${config.apiUrl}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  const json = await res.json() as { data?: T; error?: string; message?: string }
  if (!res.ok) {
    throw new Error(json.message ?? json.error ?? `API error: ${res.status}`)
  }
  return json.data as T
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// ─── Registration ──────────────────────────────────────────────────────────────

export function registerCloud(program: Command): void {
  // ── Link ───────────────────────────────────────────────────────────────────
  program
    .command("link")
    .description("Link this local project to a Supatype cloud project")
    .option("--project <slug>", "Project slug to link to")
    .option("--api-url <url>", "Control plane API URL", "https://api.supatype.io")
    .option("--token <token>", "Authentication token")
    .action(async (opts: { project?: string; apiUrl: string; token?: string }) => {
      const cwd = process.cwd()
      const token = opts.token ?? process.env["SUPATYPE_TOKEN"]
      if (!token) {
        console.error("Authentication required. Set SUPATYPE_TOKEN or pass --token.")
        process.exit(1)
      }

      const config: CloudConfig = { apiUrl: opts.apiUrl, token }

      if (opts.project) {
        config.projectSlug = opts.project
      } else {
        // List projects and let user choose
        const projects = await cloudFetch<Array<{ slug: string; name: string; status: string; tier: string }>>(
          config, "GET", "/projects",
        )
        if (projects.length === 0) {
          console.error("No projects found. Create one with: supatype projects create <name>")
          process.exit(1)
        }

        console.log("\nAvailable projects:\n")
        projects.forEach((p, i) => {
          console.log(`  ${i + 1}. ${p.name} (${p.slug}) [${p.tier}] — ${p.status}`)
        })

        const answer = await prompt(`\nSelect project (1-${projects.length}): `)
        const idx = parseInt(answer, 10) - 1
        if (isNaN(idx) || idx < 0 || idx >= projects.length) {
          console.error("Invalid selection.")
          process.exit(1)
        }
        config.projectSlug = projects[idx]!.slug
      }

      saveCloudConfig(cwd, config)
      console.log(`\nLinked to project: ${config.projectSlug}`)
      console.log(`Config saved to .supatype/cloud.json\n`)
    })

  // ── Deploy ─────────────────────────────────────────────────────────────────
  program
    .command("deploy")
    .description("Deploy schema to the linked cloud project")
    .option("--environment <name>", "Target environment", "production")
    .action(async (opts: { environment: string }) => {
      const cwd = process.cwd()
      const config = loadCloudConfig(cwd)
      if (!config?.projectSlug) {
        console.error("Not linked to a cloud project. Run: supatype link")
        process.exit(1)
      }

      console.log(`Deploying to ${config.projectSlug} (${opts.environment})...`)

      // Load schema AST
      const { loadConfig: loadAppConfig, loadSchemaAst } = await import("../config.js")
      const { ensureEngine, invokeEngine } = await import("../engine.js")

      const appConfig = loadAppConfig(cwd)
      const ast = loadSchemaAst(appConfig.schema, cwd)

      // Generate migration SQL locally using the engine
      await ensureEngine()
      const migrateResult = invokeEngine(
        ["migrate", "--format", "sql"],
        JSON.stringify(ast),
      )
      if (migrateResult.exitCode !== 0) {
        console.error("Failed to generate migration:", migrateResult.stderr || migrateResult.stdout)
        process.exit(1)
      }

      const { createHash } = await import("node:crypto")
      const schemaHash = createHash("sha256").update(JSON.stringify(ast)).digest("hex").slice(0, 16)

      const deployment = await cloudFetch<{
        id: string; status: string; errorMessage?: string
      }>(config, "POST", `/projects/${config.projectSlug}/deploy`, {
        environment: opts.environment,
        schemaHash,
        migrationSql: migrateResult.stdout,
      })

      if (deployment.status === "success") {
        console.log(`\nDeployment successful (${deployment.id})`)
      } else if (deployment.status === "failed") {
        console.error(`\nDeployment failed: ${deployment.errorMessage}`)
        process.exit(1)
      } else {
        console.log(`\nDeployment ${deployment.status} (${deployment.id})`)
      }
    })

  // ── Projects ───────────────────────────────────────────────────────────────
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
        console.log("No projects. Create one with: supatype projects create <name>")
        return
      }

      console.log("\n  Name                    Slug                     Tier    Region    Status")
      console.log("  " + "─".repeat(80))
      for (const p of projects) {
        console.log(
          `  ${p.name.padEnd(24)}${p.slug.padEnd(25)}${p.tier.padEnd(8)}${p.region.padEnd(10)}${p.status}`,
        )
      }
      console.log()
    })

  projectsCmd
    .command("create <name>")
    .description("Create a new project")
    .option("--tier <tier>", "Project tier (free, pro, team)", "free")
    .option("--region <region>", "Region (eu-fsn, eu-nbg, eu-hel)", "eu-fsn")
    .action(async (name: string, opts: { tier: string; region: string }) => {
      const config = getCloudConfigOrExit()

      console.log(`Creating project "${name}" (${opts.tier}, ${opts.region})...`)

      const project = await cloudFetch<{ slug: string; name: string; status: string }>(
        config, "POST", "/projects",
        { name, tier: opts.tier, region: opts.region },
      )

      console.log(`\nProject created: ${project.name} (${project.slug})`)
      console.log(`Status: ${project.status}`)
      console.log(`\nTo link this project: supatype link --project ${project.slug}\n`)
    })

  projectsCmd
    .command("pause <slug>")
    .description("Pause a project")
    .action(async (slug: string) => {
      const config = getCloudConfigOrExit()
      await cloudFetch(config, "POST", `/projects/${slug}/pause`)
      console.log(`Project ${slug} paused.`)
    })

  projectsCmd
    .command("resume <slug>")
    .description("Resume a paused project")
    .action(async (slug: string) => {
      const config = getCloudConfigOrExit()
      await cloudFetch(config, "POST", `/projects/${slug}/resume`)
      console.log(`Project ${slug} resumed.`)
    })

  // ── Domains ────────────────────────────────────────────────────────────────
  const domainsCmd = program
    .command("domains")
    .description("Manage custom domains for a project")

  domainsCmd
    .command("list")
    .description("List domains for the linked project")
    .action(async () => {
      const config = getCloudConfigOrExit()
      if (!config.projectSlug) {
        console.error("Not linked to a project. Run: supatype link")
        process.exit(1)
      }

      const domains = await cloudFetch<Array<{
        domain: string; status: string; cnameTarget: string; sslExpiresAt: string | null
      }>>(config, "GET", `/projects/${config.projectSlug}/domains`)

      if (domains.length === 0) {
        console.log("No custom domains configured.")
        return
      }

      console.log("\n  Domain                          Status               CNAME Target")
      console.log("  " + "─".repeat(80))
      for (const d of domains) {
        console.log(
          `  ${d.domain.padEnd(34)}${d.status.padEnd(21)}${d.cnameTarget}`,
        )
      }
      console.log()
    })

  domainsCmd
    .command("add <domain>")
    .description("Add a custom domain")
    .action(async (domain: string) => {
      const config = getCloudConfigOrExit()
      if (!config.projectSlug) {
        console.error("Not linked to a project. Run: supatype link")
        process.exit(1)
      }

      const result = await cloudFetch<{ domain: string; cnameTarget: string; instructions: string }>(
        config, "POST", `/projects/${config.projectSlug}/domains`,
        { domain },
      )

      console.log(`\nDomain added: ${result.domain}`)
      console.log(`\n${result.instructions}`)
      console.log(`\nAfter adding the CNAME record, verify with: supatype domains verify ${domain}\n`)
    })

  domainsCmd
    .command("remove <domainId>")
    .description("Remove a custom domain")
    .action(async (domainId: string) => {
      const config = getCloudConfigOrExit()
      if (!config.projectSlug) {
        console.error("Not linked to a project. Run: supatype link")
        process.exit(1)
      }

      await cloudFetch(config, "DELETE", `/projects/${config.projectSlug}/domains/${domainId}`)
      console.log("Domain removed.")
    })

  domainsCmd
    .command("verify <domainId>")
    .description("Verify CNAME and provision SSL for a domain")
    .action(async (domainId: string) => {
      const config = getCloudConfigOrExit()
      if (!config.projectSlug) {
        console.error("Not linked to a project. Run: supatype link")
        process.exit(1)
      }

      const result = await cloudFetch<{ domain: string; status: string }>(
        config, "POST", `/projects/${config.projectSlug}/domains/${domainId}/verify`,
      )

      console.log(`Domain ${result.domain}: ${result.status}`)
    })
}

function getCloudConfigOrExit(): CloudConfig {
  const cwd = process.cwd()
  let config = loadCloudConfig(cwd)
  if (!config) {
    const token = process.env["SUPATYPE_TOKEN"]
    const apiUrl = process.env["SUPATYPE_API_URL"] ?? "https://api.supatype.io"
    if (!token) {
      console.error("Not connected to Supatype Cloud. Run: supatype link, or set SUPATYPE_TOKEN.")
      process.exit(1)
    }
    config = { apiUrl, token }
  }
  return config
}
