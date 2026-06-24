import type { Command } from "commander"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, loadSchemaAst } from "../config.js"
import { resolveRuntimeProvider, schemaPathFromProject, serverBaseUrl } from "../project-config.js"
import { ensureEngine, engineRequest, type DiffResult } from "../engine-client.js"
import { printDiffOperations, printDiffWarnings } from "../diff-output.js"
import { signJwt } from "../jwt.js"
import { provisionBucketsFromAst } from "../storage-provision.js"
import type { ExtractedSchemaAstV2 } from "../schema-ast-v2.js"
import { promptFirstAdminUser } from "./admin.js"
import { withAdminRoles } from "../studio-admin-roles.js"
import { restoreSystemRelationTargets } from "../restore-system-relation-targets.js"
import type { SupatypeProjectConfig } from "../project-config.js"
import {
  resolveTarget,
  targetSchemaDiff,
  targetSchemaPush,
  schemaPgSchema,
  type DeployTarget,
} from "../resolve-target.js"
import { loadProjectLink } from "../link.js"
import {
  buildSchemaSourcesPayload,
  cacheSchemaSourcesLocally,
  resolvePushedBy,
} from "../schema-sources.js"
import { confirm, logSkippedConfirm } from "../ui/confirm.js"
import { info, plain } from "../ui/messages.js"
import { withSpinner } from "../ui/progress.js"
import { isInteractive } from "../ui/interactive.js"

const DEV_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long"

export function registerPush(program: Command): void {
  program
    .command("push")
    .description(
      "Push schema to the database: diff, prompt for destructive changes, apply migration, generate types",
    )
    .option("--yes", "Skip confirmation prompts for destructive changes")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--env <name>", "Target environment when linked")
    .option("--direct", "Use local engine subprocess (skip control plane)")
    .option("--local", "Alias for --direct")
    .action(async (opts: {
      yes?: boolean
      connection?: string
      env?: string
      direct?: boolean
      local?: boolean
    }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const pgSchema = schemaPgSchema(cwd)
      const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)

      const linked = loadProjectLink(cwd)
      const useDirect = opts.direct || opts.local || Boolean(opts.connection)

      if (linked && !useDirect && !opts.connection) {
        const target = resolveTarget(cwd, { env: opts.env })
        await pushViaTarget(cwd, config, target, ast, pgSchema, opts.yes ?? false)
        return
      }

      if (!opts.connection && !useDirect && resolveRuntimeProvider(config) === "docker") {
        const localTarget = resolveTarget(cwd, { env: opts.env })
        if (localTarget.mode === "local" && localTarget.token) {
          await pushViaTarget(cwd, config, localTarget, ast, pgSchema, opts.yes ?? false)
          return
        }
        const { pushSchemaDocker } = await import("../dev-compose.js")
        await withSpinner("Applying schema via Docker Compose", () => pushSchemaDocker(cwd, config))
        return
      }

      const target = resolveTarget(cwd, {
        env: opts.env,
        direct: true,
        connection: opts.connection,
      })
      await pushViaTarget(cwd, config, target, ast, pgSchema, opts.yes ?? false)
    })
}

async function pushViaTarget(
  cwd: string,
  config: SupatypeProjectConfig,
  target: DeployTarget,
  ast: unknown,
  pgSchema: string,
  skipConfirm: boolean,
): Promise<void> {
  const diff = await withSpinner("Diffing against database", () =>
    targetSchemaDiff(target, ast, { schema: pgSchema }),
  )
  const ops = diff.operations ?? []
  printDiffWarnings(diff)

  if (ops.length === 0) {
    info("Schema matches the database (no DDL). Syncing Studio metadata...")
  } else {
    printDiffOperations({ operations: ops })
    const risky = ops.filter(
      (o) => o.risk === "cautious" || o.risk === "destructive" || o.risk === "warn" || o.risk === "danger",
    )
    if (risky.length > 0 && !skipConfirm) {
      if (!isInteractive()) {
        logSkippedConfirm(`${risky.length} risky operation(s) require confirmation`)
        plain("Aborted.")
        return
      }
      const confirmed = await confirm(
        `${risky.length} risky operation(s) above. Proceed?`,
        { default: false },
      )
      if (!confirmed) {
        plain("Aborted.")
        return
      }
    }
  }

  const pushResult = await withSpinner(
    ops.length > 0 ? "Applying migration" : "Syncing with engine",
    () =>
      targetSchemaPush(target, ast, {
        force: true,
        schema: pgSchema,
        schemaSources: buildSchemaSourcesPayload(cwd, resolvePushedBy()),
      }),
  )

  if ((pushResult as { status?: string }).status === "up_to_date") {
    info("Schema is up to date.")
  } else {
    info((pushResult as { message?: string }).message ?? "Migration applied.")
    const migrationName = (pushResult as { name?: string }).name
    const schemaSources = buildSchemaSourcesPayload(cwd, resolvePushedBy())
    if (migrationName && schemaSources) {
      cacheSchemaSourcesLocally(cwd, migrationName, schemaSources.gz)
    }
  }

  if (target.mode === "direct" || target.mode === "local") {
    await writeLocalAdminConfig(ast, config)
    if (ops.length > 0 && target.databaseUrl) {
      await promptFirstAdminUser(target.databaseUrl)
    }
    await generateTypesLocal(ast, config)
    await provisionLocalStorage(ast, config)
  } else {
    info(`Pushed to ${target.mode} (${target.environment}).`)
  }

  const baseUrl = (serverBaseUrl(config) ?? "").replace(/\/$/, "")
  if (baseUrl) {
    plain(`\nStudio: ${baseUrl}/studio/`)
  }
}

async function generateTypesLocal(ast: unknown, config: SupatypeProjectConfig): Promise<void> {
  if (!config.output?.types && !config.output?.client) return
  await withSpinner("Generating types", async () => {
    await ensureEngine()
    const genBody: Record<string, unknown> = { ast, lang: "typescript" }
    if (config.output?.types) genBody["types_path"] = config.output.types
    if (config.output?.client) genBody["client_path"] = config.output.client
    const genResult = await engineRequest<{ message?: string }>("/generate", genBody)
    return genResult.message ?? "Types generated."
  }).then((msg) => info(msg))
}

async function provisionLocalStorage(ast: unknown, config: SupatypeProjectConfig): Promise<void> {
  const baseUrl = serverBaseUrl(config)
  const serviceRoleKey =
    process.env["SUPATYPE_SERVICE_ROLE_KEY"] ??
    process.env["SERVICE_ROLE_KEY"] ??
    (config.server.mode === "dev"
      ? signJwt({ role: "service_role", iss: "supatype", iat: Math.floor(Date.now() / 1000) }, DEV_JWT_SECRET)
      : undefined)
  if (!baseUrl || !serviceRoleKey) return
  await ensureEngine()
  const parsedAst = await engineRequest<Pick<ExtractedSchemaAstV2, "storageBuckets">>("/parse", { ast })
  await provisionBucketsFromAst(parsedAst, `${baseUrl}/storage/v1`, serviceRoleKey)
}

async function writeLocalAdminConfig(ast: unknown, config: SupatypeProjectConfig): Promise<void> {
  const cwd = process.cwd()
  const dir = join(cwd, ".supatype")
  mkdirSync(dir, { recursive: true })
  await ensureEngine()
  const admin = withAdminRoles(await engineRequest<unknown>("/admin", { ast }), config)
  restoreSystemRelationTargets(admin, ast)
  writeFileSync(join(dir, "admin-config.json"), `${JSON.stringify(admin, null, 2)}\n`)
}
