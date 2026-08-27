import type { Command } from "commander"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, loadSchemaAst } from "../config.js"
import {
  syncManifestHooks,
  validateModelHooks,
  validateModelValidators,
  writeHooksModule,
} from "../model-hooks.js"
import { adapterEntry, readHookUpload } from "../hook-upload.js"
import { checkServiceRoleRoutes, serviceRoleProblemLines } from "../service-role-check.js"
import { fatalError } from "../ui/fatal.js"
import {
  hooksPathFromProject,
  resolveRuntimeProvider,
  schemaPathFromProject,
  serverBaseUrl,
} from "../project-config.js"
import { ensureEngine, engineRequest, type DiffResult } from "../engine-client.js"
import { assertEngineSupportsSchema } from "../engine-floor.js"
import { pinnedVersion } from "../binary-cache.js"
import { printDiffOperations, printDiffWarnings } from "../diff-output.js"
import { signJwt } from "../jwt.js"
import { provisionBucketsFromAst } from "../storage-provision.js"
import type { ExtractedSchemaAstV2 } from "../schema-ast-v2.js"
import { ensureFirstAdminUser } from "./admin.js"
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
import { targetFetch } from "../target-client.js"
import {
  buildSchemaSourcesPayload,
  cacheSchemaSourcesLocally,
  resolvePushedBy,
} from "../schema-sources.js"
import { confirm, logSkippedConfirm } from "../ui/confirm.js"
import { info, plain } from "../ui/messages.js"
import { withSpinner } from "../ui/progress.js"
import { writeGeneratedTypes } from "../type-generation.js"
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
      assertModelHooksResolve(cwd, config, ast)
      assertServiceRoleGrantsResolve(cwd, config)
      assertEngineSupportsSchema(ast, pinnedVersion("engine", config))

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

  if (target.mode === "cloud" || target.mode === "self-host") {
    await deployHooksToTarget(cwd, config, target, ast)
  }

  if (target.mode === "direct" || target.mode === "local") {
    await writeLocalAdminConfig(ast, config)
    if (target.databaseUrl) {
      await ensureFirstAdminUser(target.databaseUrl, { cwd })
    }
    await generateTypesLocal(ast, config)
    await provisionLocalStorage(ast, config)

    // Local Studio only: a cloud/self-host push must not advertise the local
    // gateway URL from config, which may not even be running.
    const baseUrl = (serverBaseUrl(config) ?? "").replace(/\/$/, "")
    if (baseUrl) {
      plain(`\nStudio: ${baseUrl}/studio/`)
    }
    return
  }

  info(`Pushed to ${target.mode} (${target.environment}).`)
  const envUrl = target.link?.environments?.[target.environment]?.apiUrl?.replace(/\/$/, "")
  if (envUrl) {
    plain(`\nProject API: ${envUrl}`)
  }
}

/**
 * Upload the hooks this schema names to a managed stack.
 *
 * On `push` rather than `functions deploy`, because the hook *map* comes from the schema: the two have
 * to move together, and a map naming a handler that was never uploaded turns every write to that table
 * into a 503.
 *
 * The handler types are written locally as well. A project pushing to cloud still edits its hooks on
 * this machine, and `hooks/_supatype/hooks.ts` is what makes them typed, it is generated, never
 * committed, so a fresh clone that has only ever pushed to cloud would otherwise have no types at all.
 */
async function deployHooksToTarget(
  cwd: string,
  config: SupatypeProjectConfig,
  target: DeployTarget,
  ast: unknown,
): Promise<void> {
  const hooksDir = hooksPathFromProject(config, cwd)
  const hooksPath = writeHooksModule(cwd, hooksDir, ast)
  if (hooksPath !== null) info(`Hook handler types written to ${hooksPath}`)

  let upload: ReturnType<typeof readHookUpload>
  try {
    upload = readHookUpload(cwd, hooksDir, ast)
  } catch (err) {
    // Refused rather than partially uploaded: the schema is already applied, so the honest thing is to
    // say the hooks did not deploy and why, leaving the previous ones in place.
    fatalError(err instanceof Error ? err.message : String(err))
    return
  }
  if (upload === null) return

  const adapter = readGeneratedAdapter(hooksDir)
  const handlers = adapter === null ? upload.handlers : [...upload.handlers, adapter]

  await withSpinner(`Deploying ${upload.handlers.length} hook(s)`, () =>
    targetFetch(target.apiBaseUrl, target.apiPrefix, {
      method: "POST",
      path: `/projects/${target.projectRef}/hooks/deploy`,
      body: { handlers, map: upload.map },
      token: target.token!,
      orgId: target.orgId,
      environment: target.mode === "cloud" ? target.environment : undefined,
    }),
  ).then(() => info(`Deployed ${upload.handlers.length} hook(s)`))
}

/** The generated adapter, flattened to the name handlers were rewritten to import. */
function readGeneratedAdapter(hooksDir: string): { name: string; source: string } | null {
  const file = join(hooksDir, "_supatype", "hooks.ts")
  if (!existsSync(file)) return null
  return adapterEntry(readFileSync(file, "utf8"))
}

async function generateTypesLocal(ast: unknown, config: SupatypeProjectConfig): Promise<void> {
  // Independent of `output`: a project with hooks needs its handler types whether or not it asked
  // for client types, and the module is written next to the functions that import it.
  const cwd = process.cwd()
  const hooksPath = writeHooksModule(cwd, hooksPathFromProject(config, cwd), ast)
  if (hooksPath !== null) info(`Hook handler types written to ${hooksPath}`)
  // The server watches this file, so a changed hook takes effect without a restart.
  if (syncManifestHooks(cwd, ast)) info("Hook map written to .supatype/manifest.json")

  if (!config.output?.types && !config.output?.client) return
  // The CLI writes these, it does not ask the engine to. Passing types_path and client_path and
  // reading only `message` meant the generated TypeScript was printed to the terminal and no file
  // was ever created, so `push` reported success and produced nothing.
  const written = await withSpinner("Generating types", async () => {
    const messages = await writeGeneratedTypes({
      cwd,
      ast,
      typesPath: config.output?.types,
      clientPath: config.output?.client,
    })
    return messages
  })
  for (const message of written) info(message)
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

/**
 * Stop the push when a declared hook names a function that is not there.
 *
 * A hook is only enforcement if it runs. A typo'd name would extract cleanly, reach the manifest, and
 * then never fire: so the write it was meant to validate would succeed and look fine. Cheaper to
 * fail here, naming the directory searched.
 */
/**
 * Refuse a push whose `functions.serviceRole` names a function that does not exist.
 *
 * The grant fails closed, which is the safe direction and the invisible one: the function reads no key
 * at runtime, in a deploy that reported success. A warning is printed for an entry that is merely
 * redundant, since a reader would reasonably assume the line is what does the granting.
 */
function assertServiceRoleGrantsResolve(cwd: string, config: SupatypeProjectConfig): void {
  const problems = checkServiceRoleRoutes(config, cwd)
  for (const warning of problems.warnings) plain(warning)
  const lines = serviceRoleProblemLines(problems)
  if (lines.length === 0) return
  fatalError("functions.serviceRole names a function that does not exist.", lines, {
    brand: { intro: "Push" },
  })
}

function assertModelHooksResolve(cwd: string, config: SupatypeProjectConfig, ast: unknown): void {
  const dir = hooksPathFromProject(config, cwd)

  const problems = validateModelHooks(ast, dir, cwd)
  if (problems.length > 0) {
    fatalError("A model declares a hook whose function does not exist.", problems, {
      brand: { intro: "Push" },
    })
  }

  // Reported separately from hooks, because the fix is different: a missing validator means a field
  // nobody is checking, and the message should say so rather than talk about lifecycle events.
  const validatorProblems = validateModelValidators(ast, dir, cwd)
  if (validatorProblems.length > 0) {
    fatalError(
      "A model declares a field validator whose function does not exist, so that field would be " +
        "written unchecked.",
      validatorProblems,
      { brand: { intro: "Push" } },
    )
  }
}
