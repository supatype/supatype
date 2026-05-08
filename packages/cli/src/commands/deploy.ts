/**
 * Deploy commands:
 *   supatype deploy              — Supatype Cloud by default (linked via supatype link), else platform projectRef; use --local for engine + DB
 *   supatype deploy --local      — push schema via local engine + optional static app to .supatype/static
 *   supatype deploy --app-only   — only build & deploy the static site
 *   supatype deploy --schema-only — only push schema changes
 *   supatype deploy --skip-build — deploy existing build output (no build step)
 *   supatype deploy --preview    — deploy to a preview URL
 *   supatype deploy rollback     — roll back to previous deployment
 *   supatype deploy status       — show current deployment info
 *   supatype deploy logs <version> — show build logs
 */

import type { Command } from "commander"
import { existsSync, readdirSync, statSync, createReadStream } from "node:fs"
import { join } from "node:path"
import { loadConfig, loadSchemaAst } from "../config.js"
import { connectionString, schemaPathFromProject } from "../project-config.js"
import { deploySchemaToLinkedProject, loadCloudConfig } from "./cloud.js"
import { ensureEngine, engineRequest, type DiffResult } from "../engine-client.js"
import { resolveAppConfig, validateStaticMode, validateBuildOutput, detectPackageManager } from "../app/framework.js"
import { TIER_LIMITS, type Tier } from "./deploy-types.js"
import { spawnSync } from "node:child_process"

export function registerDeploy(program: Command): void {
  const deploy = program
    .command("deploy")
    .description(
      "Deploy schema and app — Supatype Cloud by default when linked (`supatype link`); pass --local for engine + your database",
    )
    .option("--local", "Use local schema engine and database_url from config (skip cloud control plane)")
    .option("--environment <name>", "Cloud environment when using linked project", "production")
    .option("--app-only", "Skip schema push, only deploy the static site")
    .option("--schema-only", "Skip app build, only push schema changes")
    .option("--skip-build", "Deploy existing build output without building")
    .option("--preview", "Deploy to a temporary preview URL")
    .option("--yes", "Skip confirmation prompts")
    .action(async (opts: {
      local?: boolean
      environment?: string
      appOnly?: boolean
      schemaOnly?: boolean
      skipBuild?: boolean
      preview?: boolean
      yes?: boolean
    }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const cloudCfg = loadCloudConfig(cwd)

      let schemaDone = false

      // Default: cloud — .supatype/cloud.json → control plane schema deploy
      if (
        !opts.local &&
        cloudCfg?.projectSlug &&
        !opts.appOnly &&
        !opts.skipBuild
      ) {
        await deploySchemaToLinkedProject(cwd, opts.environment ?? "production")
        schemaDone = true
        if (opts.schemaOnly) {
          return
        }
      }

      // Step 1: Schema push (unless --app-only or --skip-build, or already done via cloud.json)
      if (!opts.appOnly && !opts.skipBuild && !schemaDone) {
        const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)

        if (opts.local) {
          console.log("=== Schema Push (local) ===")
          await ensureEngine()

          const diff = await engineRequest<DiffResult>("/diff", {
            ast,
            database_url: connectionString(config),
            schema: "public",
          })

          const ops = diff.operations ?? []

          if (ops.length > 0) {
            console.log(`${ops.length} schema change(s) to apply.`)
            await engineRequest("/push", {
              ast,
              database_url: connectionString(config),
              schema: "public",
              force: true,
            })
            console.log("Schema changes applied.")
          } else {
            console.log("Schema is up to date.")
          }
        } else if (cloudCfg?.projectSlug) {
          console.log("=== Schema Push ===")
          // Platform API — no local Docker needed
          const apiUrl = cloudCfg.apiUrl || "https://api.supatype.io"
          const token = cloudCfg.token || process.env["SUPATYPE_ACCESS_TOKEN"] || ""

          const res = await fetch(`${apiUrl}/platform/v1/projects/${cloudCfg.projectSlug}/schema/push`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ ast }),
          })
          if (!res.ok) {
            const body = await res.text()
            console.error(`Schema push failed: ${res.status} ${body}`)
            process.exit(1)
          }
          const pushData = await res.json() as { operations?: unknown[]; message?: string }
          console.log(pushData.message ?? `Schema changes applied (${pushData.operations?.length ?? 0} operations).`)
        } else {
          console.error(
            "Not linked to Supatype Cloud. Run: supatype link\n" +
              "Or deploy against your own database: supatype deploy --local",
          )
          process.exit(1)
        }
      }

      // Step 2: App build & deploy (unless --schema-only)
      if (!opts.schemaOnly) {
        if (!config.build) {
          if (opts.appOnly) {
            console.error("No build section found in supatype.config.ts")
            process.exit(1)
          }
          // No build config — skip app deployment silently
          return
        }

        console.log("\n=== App Build & Deploy ===")
        const appConfig = resolveAppConfig(config.build, cwd)

        // Validate static mode
        const staticError = validateStaticMode(appConfig.framework, appConfig.directory)
        if (staticError) {
          console.error(staticError)
          process.exit(1)
        }

        // Build step
        if (!opts.skipBuild && appConfig.buildCommand) {
          console.log(`Framework: ${appConfig.framework}`)
          console.log(`Build command: ${appConfig.buildCommand}`)
          console.log(`Output directory: ${appConfig.outputDirectory}`)
          console.log()

          // Inject environment variables
          const buildEnv: Record<string, string> = {
            ...process.env as Record<string, string>,
            ...appConfig.env,
          }

          // Inject Supatype URLs if project is linked
          if (cloudCfg?.projectSlug) {
            buildEnv["NEXT_PUBLIC_SUPATYPE_URL"] = cloudCfg.apiUrl || `https://${cloudCfg.projectSlug}.supatype.io`
            buildEnv["VITE_SUPATYPE_URL"] = buildEnv["NEXT_PUBLIC_SUPATYPE_URL"]!
            buildEnv["PUBLIC_SUPATYPE_URL"] = buildEnv["NEXT_PUBLIC_SUPATYPE_URL"]!
            // NEVER inject service_role key — only anon key is safe for client-side
          }

          // Install dependencies
          const pm = detectPackageManager(appConfig.directory)
          console.log(`Installing dependencies (${pm})...`)
          const installResult = spawnSync(pm, ["install"], {
            cwd: appConfig.directory,
            stdio: "inherit",
            env: buildEnv,
            timeout: 5 * 60 * 1000, // 5 minute timeout
          })
          if (installResult.status !== 0) {
            console.error("Dependency installation failed.")
            process.exit(1)
          }

          // Run build
          console.log("\nBuilding...")
          const [buildCmd, ...buildArgs] = appConfig.buildCommand.split(" ")
          const buildResult = spawnSync(buildCmd!, buildArgs, {
            cwd: appConfig.directory,
            stdio: "inherit",
            env: buildEnv,
            timeout: 10 * 60 * 1000, // 10 minute timeout
          })
          if (buildResult.status !== 0) {
            console.error("Build failed.")
            process.exit(1)
          }
        }

        // Validate build output
        const maxSizeMb = 500 // Default, should be tier-aware in cloud
        const validationError = validateBuildOutput(appConfig.outputDirectory, maxSizeMb)
        if (validationError) {
          console.error(validationError)
          process.exit(1)
        }

        // Deploy (--local never uploads to cloud, even if linked)
        if (cloudCfg?.projectSlug && !opts.local) {
          await deployToCloud(
            { projectRef: cloudCfg.projectSlug, apiUrl: cloudCfg.apiUrl, accessToken: cloudCfg.token },
            appConfig.outputDirectory,
            opts.preview ?? false,
          )
        } else {
          deploySelfHost(appConfig.outputDirectory, cwd)
        }

        console.log("\nDeployment complete!")
        if (cloudCfg?.projectSlug && !opts.local) {
          const url = opts.preview
            ? `https://preview-${Date.now().toString(36)}.${cloudCfg.projectSlug}.supatype.io`
            : `https://${cloudCfg.projectSlug}.supatype.io`
          console.log(`URL: ${url}`)
        }
      }
    })

  // supatype deploy rollback
  deploy
    .command("rollback")
    .description("Roll back to the previous static site deployment")
    .action(async () => {
      const cloudCfg = loadCloudConfig(process.cwd())
      if (!cloudCfg?.projectSlug) {
        console.error("Not linked to a cloud project. Rollback is only available for cloud deployments.")
        process.exit(1)
      }

      const apiUrl = cloudCfg.apiUrl || "https://api.supatype.io"
      const token = cloudCfg.token || process.env["SUPATYPE_ACCESS_TOKEN"] || ""

      const res = await fetch(`${apiUrl}/platform/v1/projects/${cloudCfg.projectSlug}/deployments/rollback`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      })

      if (!res.ok) {
        const body = await res.text()
        console.error(`Rollback failed: ${res.status} ${body}`)
        process.exit(1)
      }

      const { data } = await res.json() as { data: { version: string; message: string } }
      console.log(`Rolled back to deployment ${data.version}.`)
    })

  // supatype deploy status
  deploy
    .command("status")
    .description("Show current deployment status")
    .action(async () => {
      const cloudCfg = loadCloudConfig(process.cwd())
      if (!cloudCfg?.projectSlug) {
        console.error("Not linked to a cloud project.")
        process.exit(1)
      }

      const apiUrl = cloudCfg.apiUrl || "https://api.supatype.io"
      const token = cloudCfg.token || process.env["SUPATYPE_ACCESS_TOKEN"] || ""

      const res = await fetch(`${apiUrl}/platform/v1/projects/${cloudCfg.projectSlug}/deployments/current`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!res.ok) {
        console.error("No active deployment found.")
        return
      }

      const { data } = await res.json() as { data: {
        version: string
        timestamp: string
        size: number
        buildDuration: number
        url: string
        status: string
      }}

      console.log(`Deployment: ${data.version}`)
      console.log(`Status: ${data.status}`)
      console.log(`Deployed: ${data.timestamp}`)
      console.log(`Size: ${(data.size / (1024 * 1024)).toFixed(1)}MB`)
      console.log(`Build duration: ${data.buildDuration}s`)
      console.log(`URL: ${data.url}`)
    })

  // supatype deploy logs <version>
  deploy
    .command("logs [version]")
    .description("Show build logs for a deployment")
    .action(async (version?: string) => {
      const cloudCfg = loadCloudConfig(process.cwd())
      if (!cloudCfg?.projectSlug) {
        console.error("Not linked to a cloud project.")
        process.exit(1)
      }

      const apiUrl = cloudCfg.apiUrl || "https://api.supatype.io"
      const token = cloudCfg.token || process.env["SUPATYPE_ACCESS_TOKEN"] || ""

      const versionPath = version ? `/${version}` : "/current"
      const res = await fetch(`${apiUrl}/platform/v1/projects/${cloudCfg.projectSlug}/deployments${versionPath}/logs`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!res.ok) {
        console.error("Logs not found.")
        process.exit(1)
      }

      const { data } = await res.json() as { data: { logs: string } }
      console.log(data.logs)
    })
}

async function deployToCloud(
  config: { projectRef?: string; apiUrl?: string; accessToken?: string },
  outputDir: string,
  isPreview: boolean,
): Promise<void> {
  const apiUrl = config.apiUrl || "https://api.supatype.io"
  const token = config.accessToken || process.env["SUPATYPE_ACCESS_TOKEN"] || ""

  console.log("Uploading build artifacts...")

  // Collect files from output directory
  const files = collectFiles(outputDir, outputDir)
  console.log(`${files.length} files to upload (${formatSize(files.reduce((s, f) => s + f.size, 0))})`)

  // Create deployment
  const createRes = await fetch(`${apiUrl}/platform/v1/projects/${config.projectRef}/deployments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      preview: isPreview,
      fileCount: files.length,
      totalSize: files.reduce((s, f) => s + f.size, 0),
      files: files.map((f) => ({ path: f.relativePath, size: f.size })),
    }),
  })

  if (!createRes.ok) {
    const body = await createRes.text()
    throw new Error(`Failed to create deployment: ${createRes.status} ${body}`)
  }

  const { data } = await createRes.json() as { data: { deploymentId: string; uploadUrl: string } }

  // Upload files (simplified — in production, use multipart or presigned URLs)
  for (const file of files) {
    const content = require("node:fs").readFileSync(file.absolutePath)
    await fetch(`${data.uploadUrl}/${file.relativePath}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "X-Deployment-Id": data.deploymentId,
      },
      body: content,
    })
  }

  // Finalize deployment
  await fetch(`${apiUrl}/platform/v1/projects/${config.projectRef}/deployments/${data.deploymentId}/finalize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  })
}

function deploySelfHost(outputDir: string, cwd: string): void {
  const servingDir = join(cwd, ".supatype", "static")
  const { mkdirSync, cpSync } = require("node:fs") as typeof import("node:fs")
  mkdirSync(servingDir, { recursive: true })
  cpSync(outputDir, servingDir, { recursive: true })
  console.log(`Static files deployed to ${servingDir}`)
}

interface FileEntry {
  absolutePath: string
  relativePath: string
  size: number
}

function collectFiles(dir: string, baseDir: string): FileEntry[] {
  const files: FileEntry[] = []
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs")
  const { relative } = require("node:path") as typeof import("node:path")

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isFile()) {
      files.push({
        absolutePath: fullPath,
        relativePath: relative(baseDir, fullPath).replace(/\\/g, "/"),
        size: statSync(fullPath).size,
      })
    } else if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, baseDir))
    }
  }
  return files
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
