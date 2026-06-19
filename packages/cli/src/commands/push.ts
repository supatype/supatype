import type { Command } from "commander"
import { mkdirSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
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
        await pushSchemaDocker(cwd, config)
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
  console.log("Diffing against database...")
  const diff = await targetSchemaDiff(target, ast, { schema: pgSchema })
  const ops = diff.operations ?? []
  printDiffWarnings(diff)

  if (ops.length === 0) {
    console.log("Schema matches the database (no DDL). Syncing Studio metadata...")
  } else {
    printDiffOperations({ operations: ops })
    const risky = ops.filter(
      (o) => o.risk === "cautious" || o.risk === "destructive" || o.risk === "warn" || o.risk === "danger",
    )
    if (risky.length > 0 && !skipConfirm) {
      const confirmed = await confirm(
        `\n${risky.length} risky operation(s) above. Proceed? [y/N] `,
      )
      if (!confirmed) {
        console.log("Aborted.")
        return
      }
    }
  }

  console.log(ops.length > 0 ? "\nApplying migration..." : "\nSyncing with engine...")
  const schemaSources = buildSchemaSourcesPayload(cwd, resolvePushedBy())
  const pushResult = await targetSchemaPush(target, ast, {
    force: true,
    schema: pgSchema,
    schemaSources,
  })
  if ((pushResult as { status?: string }).status === "up_to_date") {
    console.log("Schema is up to date.")
  } else {
    console.log((pushResult as { message?: string }).message ?? "Migration applied.")
    const migrationName = (pushResult as { name?: string }).name
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
    console.log(`Pushed to ${target.mode} (${target.environment}).`)
  }

  const baseUrl = (serverBaseUrl(config) ?? "").replace(/\/$/, "")
  if (baseUrl) {
    console.log(`\nStudio: ${baseUrl}/studio/`)
  }
}

async function generateTypesLocal(ast: unknown, config: SupatypeProjectConfig): Promise<void> {
  if (!config.output?.types && !config.output?.client) return
  console.log("Generating types...")
  await ensureEngine()
  const genBody: Record<string, unknown> = { ast, lang: "typescript" }
  if (config.output?.types) genBody["types_path"] = config.output.types
  if (config.output?.client) genBody["client_path"] = config.output.client
  const genResult = await engineRequest<{ message?: string }>("/generate", genBody)
  console.log(genResult.message ?? "Types generated.")
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

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolveConfirm) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolveConfirm(answer.toLowerCase() === "y")
    })
  })
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
