/**
 * Deploy commands:
 *   supatype deploy              — push schema + build & deploy static site
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
import { ensureEngine, invokeEngine } from "../engine.js"
import { resolveAppConfig, validateStaticMode, validateBuildOutput, detectPackageManager } from "../app/framework.js"
import { TIER_LIMITS, type Tier } from "./deploy-types.js"
import { spawnSync } from "node:child_process"

export function registerDeploy(program: Command): void {
  const deploy = program
    .command("deploy")
    .description("Build and deploy your application")
    .option("--app-only", "Skip schema push, only deploy the static site")
    .option("--schema-only", "Skip app build, only push schema changes")
    .option("--skip-build", "Deploy existing build output without building")
    .option("--preview", "Deploy to a temporary preview URL")
    .option("--yes", "Skip confirmation prompts")
    .action(async (opts: {
      appOnly?: boolean
      schemaOnly?: boolean
      skipBuild?: boolean
      preview?: boolean
      yes?: boolean
    }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)

      // Step 1: Schema push (unless --app-only or --skip-build)
      if (!opts.appOnly && !opts.skipBuild) {
        console.log("=== Schema Push ===")
        await ensureEngine()

        const ast = loadSchemaAst(config.schema, cwd)
        const diffResult = invokeEngine(
          ["diff", "--connection", config.connection, "--format", "json"],
          JSON.stringify(ast),
        )
        if (diffResult.exitCode !== 0) {
          console.error("Schema diff failed:", diffResult.stderr || diffResult.stdout)
          process.exit(1)
        }

        const diff = JSON.parse(diffResult.stdout)
        const ops = diff.operations ?? []

        if (ops.length > 0) {
          console.log(`${ops.length} schema change(s) to apply.`)
          const migrateResult = invokeEngine(
            ["migrate", "--connection", config.connection],
            JSON.stringify(ast),
          )
          if (migrateResult.exitCode !== 0) {
            console.error("Migration failed:", migrateResult.stderr)
            process.exit(1)
          }
          console.log("Schema changes applied.")
        } else {
          console.log("Schema is up to date.")
        }
      }

      // Step 2: App build & deploy (unless --schema-only)
      if (!opts.schemaOnly) {
        if (!config.app) {
          if (opts.appOnly) {
            console.error("No app configuration found in supatype.config.ts")
            process.exit(1)
          }
          // No app config — just skip app deployment silently
          return
        }

        console.log("\n=== App Build & Deploy ===")
        const appConfig = resolveAppConfig(config.app, cwd)

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
          if (config.projectRef) {
            buildEnv["NEXT_PUBLIC_SUPATYPE_URL"] = config.apiUrl || `https://${config.projectRef}.supatype.io`
            buildEnv["VITE_SUPATYPE_URL"] = buildEnv["NEXT_PUBLIC_SUPATYPE_URL"]
            buildEnv["PUBLIC_SUPATYPE_URL"] = buildEnv["NEXT_PUBLIC_SUPATYPE_URL"]
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

        // Deploy
        if (config.projectRef) {
          // Cloud deployment — upload to API
          await deployToCloud(config, appConfig.outputDirectory, opts.preview ?? false)
        } else {
          // Self-host — copy to serving directory
          deploySelfHost(appConfig.outputDirectory, cwd)
        }

        console.log("\nDeployment complete!")
        if (config.projectRef) {
          const url = opts.preview
            ? `https://preview-${Date.now().toString(36)}.${config.projectRef}.supatype.io`
            : `https://${config.projectRef}.supatype.io`
          console.log(`URL: ${url}`)
        }
      }
    })

  // supatype deploy rollback
  deploy
    .command("rollback")
    .description("Roll back to the previous static site deployment")
    .action(async () => {
      const config = loadConfig(process.cwd())
      if (!config.projectRef) {
        console.error("Not linked to a cloud project. Rollback is only available for cloud deployments.")
        process.exit(1)
      }

      const apiUrl = config.apiUrl || "https://api.supatype.io"
      const token = config.accessToken || process.env["SUPATYPE_ACCESS_TOKEN"] || ""

      const res = await fetch(`${apiUrl}/platform/v1/projects/${config.projectRef}/deployments/rollback`, {
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
      const config = loadConfig(process.cwd())
      if (!config.projectRef) {
        console.error("Not linked to a cloud project.")
        process.exit(1)
      }

      const apiUrl = config.apiUrl || "https://api.supatype.io"
      const token = config.accessToken || process.env["SUPATYPE_ACCESS_TOKEN"] || ""

      const res = await fetch(`${apiUrl}/platform/v1/projects/${config.projectRef}/deployments/current`, {
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
      const config = loadConfig(process.cwd())
      if (!config.projectRef) {
        console.error("Not linked to a cloud project.")
        process.exit(1)
      }

      const apiUrl = config.apiUrl || "https://api.supatype.io"
      const token = config.accessToken || process.env["SUPATYPE_ACCESS_TOKEN"] || ""

      const versionPath = version ? `/${version}` : "/current"
      const res = await fetch(`${apiUrl}/platform/v1/projects/${config.projectRef}/deployments${versionPath}/logs`, {
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
