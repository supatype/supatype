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
import { existsSync, readdirSync, statSync, createReadStream, mkdirSync, cpSync } from "node:fs"
import { join, relative } from "node:path"
import { loadConfig, loadSchemaAst } from "../config.js"
import { connectionString, schemaPathFromProject } from "../project-config.js"
import { deploySchemaToLinkedProject, loadCloudConfig, pushSchemaToLinkedProject } from "./cloud.js"
import { loadProjectLink } from "../link.js"
import { resolveTarget } from "../resolve-target.js"
import { targetFetch } from "../target-client.js"
import { ensureEngine, engineRequest, type DiffResult } from "../engine-client.js"
import { resolveAppConfig, validateStaticMode, validateBuildOutput, detectPackageManager } from "../app/framework.js"
import { TIER_LIMITS, type Tier } from "./deploy-types.js"
import { spawnSync } from "node:child_process"
import { error, info, plain, step, warn } from "../ui/messages.js"
import { withSpinner } from "../ui/progress.js"

export function registerDeploy(program: Command): void {
  const deploy = program
    .command("deploy")
    .description(
      "Deploy schema and app — Supatype Cloud by default when linked (`supatype link`); pass --local for engine + your database",
    )
    .option("--local", "Use local schema engine and database_url from config (skip cloud control plane)")
    .option("--environment <name>", "Target environment when linked", "production")
    .option("--env <name>", "Alias for --environment")
    .option("--app-only", "Skip schema push, only deploy the static site")
    .option("--schema-only", "Skip app build, only push schema changes")
    .option("--skip-build", "Deploy existing build output without building")
    .option("--preview", "Deploy to a temporary preview URL")
    .option("--yes", "Skip confirmation prompts")
    .action(async (opts: {
      local?: boolean
      environment?: string
      env?: string
      appOnly?: boolean
      schemaOnly?: boolean
      skipBuild?: boolean
      preview?: boolean
      yes?: boolean
    }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const link = loadProjectLink(cwd)
      const cloudCfg = loadCloudConfig(cwd)
      const envName = opts.env ?? opts.environment ?? "production"

      let schemaDone = false

      if (
        !opts.local &&
        link &&
        !opts.appOnly &&
        !opts.skipBuild
      ) {
        await deploySchemaToLinkedProject(cwd, envName)
        schemaDone = true
        if (opts.schemaOnly) {
          return
        }
      }

      // Step 1: Schema push (unless --app-only or --skip-build, or already done via cloud.json)
      if (!opts.appOnly && !opts.skipBuild && !schemaDone) {
        const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)

        if (opts.local) {
          step("Schema Push (local)")
          await ensureEngine()

          const diff = await engineRequest<DiffResult>("/diff", {
            ast,
            database_url: connectionString(config),
            schema: "public",
          })

          const ops = diff.operations ?? []

          if (ops.length > 0) {
            info(`${ops.length} schema change(s) to apply.`)
            await engineRequest("/push", {
              ast,
              database_url: connectionString(config),
              schema: "public",
              force: true,
            })
            info("Schema changes applied.")
          } else {
            info("Schema is up to date.")
          }
        } else if (link) {
          step("Schema Push (linked)")
          await pushSchemaToLinkedProject(cwd, { force: opts.yes ?? true, env: envName })
        } else {
          error(
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
            error("No build section found in supatype.config.ts")
            process.exit(1)
          }
          // No build config — skip app deployment silently
          return
        }

        step("App Build & Deploy")
        const appConfig = resolveAppConfig(config.build, cwd)

        // Validate static mode
        const staticError = validateStaticMode(appConfig.framework, appConfig.directory)
        if (staticError) {
          error(staticError)
          process.exit(1)
        }

        // Build step
        if (!opts.skipBuild && appConfig.buildCommand) {
          info(`Framework: ${appConfig.framework}`)
          info(`Build command: ${appConfig.buildCommand}`)
          info(`Output directory: ${appConfig.outputDirectory}`)
          plain()

          // Inject environment variables
          const buildEnv: Record<string, string> = {
            ...process.env as Record<string, string>,
            ...appConfig.env,
          }

          // Inject Supatype URLs if project is linked
          if (cloudCfg?.projectSlug) {
            buildEnv["NEXT_PUBLIC_SUPATYPE_URL"] = cloudCfg.apiUrl || `https://${cloudCfg.projectSlug}.supatype.dev`
            buildEnv["VITE_SUPATYPE_URL"] = buildEnv["NEXT_PUBLIC_SUPATYPE_URL"]!
            buildEnv["PUBLIC_SUPATYPE_URL"] = buildEnv["NEXT_PUBLIC_SUPATYPE_URL"]!
            // NEVER inject service_role key — only anon key is safe for client-side
          }

          // Install dependencies
          const pm = detectPackageManager(appConfig.directory)
          info(`Installing dependencies (${pm})...`)
          const installResult = spawnSync(pm, ["install"], {
            cwd: appConfig.directory,
            stdio: "inherit",
            env: buildEnv,
            timeout: 5 * 60 * 1000, // 5 minute timeout
          })
          if (installResult.status !== 0) {
            error("Dependency installation failed.")
            process.exit(1)
          }

          // Run build
          plain("\nBuilding...")
          const [buildCmd, ...buildArgs] = appConfig.buildCommand.split(" ")
          const buildResult = spawnSync(buildCmd!, buildArgs, {
            cwd: appConfig.directory,
            stdio: "inherit",
            env: buildEnv,
            timeout: 10 * 60 * 1000, // 10 minute timeout
          })
          if (buildResult.status !== 0) {
            error("Build failed.")
            process.exit(1)
          }
        }

        // Validate build output
        const maxSizeMb = 500 // Default, should be tier-aware in cloud
        const validationError = validateBuildOutput(appConfig.outputDirectory, maxSizeMb)
        if (validationError) {
          error(validationError)
          process.exit(1)
        }

        // Deploy (--local never uploads to cloud, even if linked)
        if (link && !opts.local) {
          await deployStaticSite(cwd, appConfig.outputDirectory, {
            preview: opts.preview ?? false,
            env: envName,
          })
        } else {
          deploySelfHost(appConfig.outputDirectory, cwd)
        }

        info("Deployment complete!")
        if (link && !opts.local) {
          const target = resolveTarget(cwd, { env: envName })
          const url = opts.preview
            ? `${target.apiBaseUrl}/preview`
            : target.apiBaseUrl
          info(`URL: ${url}`)
        }
      }
    })

  // supatype deploy rollback
  deploy
    .command("rollback")
    .description("Roll back to the previous static site deployment")
    .option("--env <name>", "Target environment when linked")
    .option("--to <id>", "Roll back to a specific deployment id or version")
    .action(async (opts: { env?: string; to?: string }) => {
      const cwd = process.cwd()
      const link = loadProjectLink(cwd)
      if (!link) {
        error("Not linked to a project. Rollback requires a linked target.")
        process.exit(1)
      }

      const target = resolveTarget(cwd, { env: opts.env })
      const body = opts.to ? { to: opts.to } : undefined
      const data = await targetFetch<{ version: string; message: string }>(
        target.apiBaseUrl,
        target.apiPrefix,
        {
          method: "POST",
          path: `/projects/${target.projectRef}/deployments/rollback`,
          body,
          token: target.token!,
          orgId: target.orgId,
          environment: target.mode === "cloud" ? target.environment : undefined,
        },
      )

      info(`Rolled back to deployment ${data.version ?? "previous"}.`)
    })

  // supatype deploy status
  deploy
    .command("status")
    .description("Show current deployment status")
    .option("--env <name>", "Target environment when linked")
    .action(async (opts: { env?: string }) => {
      const cwd = process.cwd()
      const link = loadProjectLink(cwd)
      if (!link) {
        error("Not linked to a project.")
        process.exit(1)
      }

      const target = resolveTarget(cwd, { env: opts.env })
      const data = await targetFetch<{
        version?: string
        id?: string
        timestamp?: string
        createdAt?: string
        size?: number
        buildDuration?: number
        url?: string
        status?: string
      } | null>(
        target.apiBaseUrl,
        target.apiPrefix,
        {
          method: "GET",
          path: `/projects/${target.projectRef}/deployments/current`,
          token: target.token!,
          orgId: target.orgId,
          environment: target.mode === "cloud" ? target.environment : undefined,
        },
      )

      if (!data) {
        info("No active deployment found.")
        return
      }

      info(`Deployment: ${data.version ?? data.id ?? "unknown"}`)
      info(`Status: ${data.status ?? "live"}`)
      if (data.timestamp ?? data.createdAt) {
        info(`Deployed: ${data.timestamp ?? data.createdAt}`)
      }
      if (data.size) info(`Size: ${(data.size / (1024 * 1024)).toFixed(1)}MB`)
      if (data.buildDuration) info(`Build duration: ${data.buildDuration}s`)
      if (data.url) info(`URL: ${data.url}`)
    })

  // supatype deploy logs <version>
  deploy
    .command("logs [version]")
    .description("Show build logs for a deployment")
    .option("--env <name>", "Target environment when linked")
    .action(async (version: string | undefined, opts: { env?: string }) => {
      const cwd = process.cwd()
      const link = loadProjectLink(cwd)
      if (!link) {
        error("Not linked to a project.")
        process.exit(1)
      }

      const target = resolveTarget(cwd, { env: opts.env })
      const versionPath = version ? `/${version}` : "/current"
      const data = await targetFetch<{ logs: string }>(
        target.apiBaseUrl,
        target.apiPrefix,
        {
          method: "GET",
          path: `/projects/${target.projectRef}/deployments${versionPath}/logs`,
          token: target.token!,
          orgId: target.orgId,
          environment: target.mode === "cloud" ? target.environment : undefined,
        },
      )

      plain(data.logs ?? "(no logs)")
    })
}

async function deployStaticSite(
  cwd: string,
  outputDir: string,
  opts: { preview?: boolean; env?: string },
): Promise<void> {
  const target = resolveTarget(cwd, { env: opts.env })
  const token = target.token
  if (!token) {
    throw new Error("No token for linked target. Re-run supatype link --token ...")
  }

  info("Uploading build artifacts...")
  const files = collectFiles(outputDir, outputDir)
  info(`${files.length} files to upload (${formatSize(files.reduce((s, f) => s + f.size, 0))})`)

  const { readFileSync } = await import("node:fs")

  if (target.apiPrefix === "/platform/v1") {
    const filePayload = files.map((f) => ({
      path: f.relativePath,
      content: readFileSync(f.absolutePath).toString("base64"),
      encoding: "base64",
    }))

    const created = await targetFetch<{ id: string }>(
      target.apiBaseUrl,
      target.apiPrefix,
      {
        method: "POST",
        path: `/projects/${target.projectRef}/deployments`,
        body: { preview: opts.preview ?? false, files: filePayload },
        token,
        orgId: target.orgId,
      },
    )

    await targetFetch(
      target.apiBaseUrl,
      target.apiPrefix,
      {
        method: "POST",
        path: `/projects/${target.projectRef}/deployments/${created.id}/finalize`,
        token,
        orgId: target.orgId,
      },
    )
    return
  }

  const createRes = await fetch(`${target.apiBaseUrl}/api/v1/projects/${target.projectRef}/deployments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(target.orgId ? { "X-Org-Id": target.orgId } : {}),
      ...(target.environment ? { "X-Supatype-Environment": target.environment } : {}),
    },
    body: JSON.stringify({
      preview: opts.preview ?? false,
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

  for (const file of files) {
    const content = readFileSync(file.absolutePath)
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

  await fetch(
    `${target.apiBaseUrl}/api/v1/projects/${target.projectRef}/deployments/${data.deploymentId}/finalize`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(target.orgId ? { "X-Org-Id": target.orgId } : {}),
      },
    },
  )
}

function deploySelfHost(outputDir: string, cwd: string): void {
  const servingDir = join(cwd, ".supatype", "static")
  mkdirSync(servingDir, { recursive: true })
  cpSync(outputDir, servingDir, { recursive: true })
  info(`Static files deployed to ${servingDir}`)
}

interface FileEntry {
  absolutePath: string
  relativePath: string
  size: number
}

function collectFiles(dir: string, baseDir: string): FileEntry[] {
  const files: FileEntry[] = []

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
