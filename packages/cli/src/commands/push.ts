import { withPublishing } from "../model-versioning.js"
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
import { rowCacheChangeNote, syncRowCacheEnv } from "../model-cache.js"
import { adapterEntry, readHookUpload } from "../hook-upload.js"
import { checkServiceRoleRoutes, serviceRoleProblemLines } from "../service-role-check.js"
import { fatalError } from "../ui/fatal.js"
import {
  hooksPathFromProject,
  resolveRuntimeProvider,
  schemaPathFromProject,
} from "../project-config.js"
import { isProjectDatabase, projectStackUrl, studioUrlAt } from "../local-stack.js"
import { byoPreflight } from "../byo-preflight.js"
import { devApiKeys, shellServiceRoleKey } from "../dev-api-keys.js"
import { ensureEngine, engineRequest, type DiffResult } from "../engine-client.js"
import { assertEngineSupportsSchema } from "../engine-floor.js"
import {
  modelsWithUnresolvablePreview,
  unresolvablePreviewMessage,
} from "../preview-config-check.js"
import { hasEngineOverride, pinnedVersion } from "../binary-cache.js"
import {
  formatSecurityDrift,
  isRisky,
  plannedChanges,
  printDiffOperations,
  printDiffWarnings,
  securityDrift,
} from "../diff-output.js"
import { printPushWarnings } from "../engine-push-output.js"
import { askToOverwrite, pushConsentingToDrift } from "../drift-consent.js"
import { consentDepsFromDiff, pushConsentingToDestructive, settleRenames } from "../destructive-consent.js"
import { adoptKeysNeed, OVERWRITE_DRIFT_NEED } from "../engine-ownership-gate.js"
import { pushOfferingAdoption, targetAdoptionSteps } from "../adopt-walkthrough.js"
import { explainingRefusal } from "../push-refusal.js"
import { isParsedBuckets, provisionBucketsFromAst } from "../storage-provision.js"
import type { ExtractedSchemaAstV2 } from "../schema-ast-v2.js"
import { ensureFirstAdminUser } from "./admin.js"
import { withAdminRoles } from "../studio-admin-roles.js"
import { restoreSystemRelationTargets } from "../restore-system-relation-targets.js"
import { cacheSeedingNotes, freeTierCacheNote } from "../api-config-cache.js"
import { refreshFunctionsContext } from "../functions-context-refresh.js"
import { waitForRestReady } from "../rest-ready.js"
import type { SupatypeProjectConfig } from "../project-config.js"
import {
  requireTargetFeatures,
  resolveTarget,
  targetSchemaAdopt,
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
} from "../schema-sources.js"
import { confirm, logSkippedConfirm } from "../ui/confirm.js"
import { info, plain } from "../ui/messages.js"
import { withSpinner } from "../ui/progress.js"
import { projectOutputPaths, writeGeneratedTypes } from "../type-generation.js"
import { isInteractive } from "../ui/interactive.js"
import { errorMessage } from "../error-message.js"

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
    .option(
      "--overwrite-drift",
      "Put back policies, grants, labels and RLS changed outside Supatype without asking",
    )
    .action(async (opts: {
      yes?: boolean
      overwriteDrift?: boolean
      connection?: string
      env?: string
      direct?: boolean
      local?: boolean
    }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const pgSchema = schemaPgSchema(cwd)
      const ast = pushAst(cwd, config)
      assertModelHooksResolve(cwd, config, ast)
      assertServiceRoleGrantsResolve(cwd, config)
      assertEngineSupportsSchema(ast, pinnedVersion("engine", config))
      assertPreviewAddressesResolve(config)

      const run: PushRun = { yes: opts.yes ?? false, overwriteDrift: opts.overwriteDrift ?? false }
      // A refusal (access changed by hand, another push running, an image Docker could not pull)
      // ends with what to do about it, whichever way the push went.
      // Unmanaged tables and lost data are spoken to by the push's own walkthrough.
      await explainingRefusal("supatype push", () => pushWherever(cwd, config, { ast, pgSchema, run, opts }), [
        "unmanaged-tables",
        "destructive",
      ])
    })
}

/** The schema a push sends: the project's, with its publishing config and its rename journal. */
function pushAst(cwd: string, config: SupatypeProjectConfig): ExtractedSchemaAstV2 {
  return withPublishing(loadSchemaAst(schemaPathFromProject(config, cwd), cwd), config)
}

/** Where `push` sends the schema: a linked project, a docker stack, or a database directly. */
async function pushWherever(
  cwd: string,
  config: SupatypeProjectConfig,
  push: { ast: unknown; pgSchema: string; run: PushRun; opts: { connection?: string; env?: string; direct?: boolean; local?: boolean } },
): Promise<void> {
  const { ast, pgSchema, run, opts } = push
  const useDirect = opts.direct === true || opts.local === true || Boolean(opts.connection)
  if (loadProjectLink(cwd) && !useDirect) {
    await pushViaTarget(cwd, config, resolveTarget(cwd, { env: opts.env }), ast, pgSchema, run)
    return
  }
  if (!useDirect && resolveRuntimeProvider(config) === "docker") {
    const localTarget = resolveTarget(cwd, { env: opts.env })
    if (localTarget.mode === "local" && localTarget.token) {
      await pushViaTarget(cwd, config, localTarget, ast, pgSchema, run)
      return
    }
    await pushDocker(cwd, config, run)
    return
  }
  const target = resolveTarget(cwd, { env: opts.env, direct: true, connection: opts.connection })
  await pushViaTarget(cwd, config, target, ast, pgSchema, run)
}

/** What applies a docker project's push: the stack's schema-engine container, or `overrides.engine`. */
export type DockerPushEngine = "compose" | "host"

/**
 * The one line a docker push prints while it applies, naming the engine that applies it. A forced
 * attempt is the retry after the engine refused a destructive change or a table rewrite and
 * consent was given, so it says that rather than printing the first attempt's line a second time.
 */
export function dockerApplyMessage(force: boolean, engine: DockerPushEngine): string {
  const via = engine === "host" ? "local engine (overrides.engine)" : "Docker Compose"
  return force
    ? `Applying schema via ${via}, with the destructive changes and rewrites now allowed`
    : `Applying schema via ${via}`
}

/**
 * `supatype push` on a docker project with no local control plane. No diff is read first on this
 * path, so the engine's refusals are where drift, unmanaged tables and lost data show up, and each
 * is asked about here. The push used to be forced, so a change that dropped a column applied with
 * no question asked; now it needs a yes in a terminal, or `--yes`.
 */
async function pushDocker(cwd: string, config: SupatypeProjectConfig, run: PushRun): Promise<void> {
  const { composeAuditArgs, dockerDiff, dockerAdoptionSteps, pushSchemaDocker, requireDockerFeatures } =
    await import("../dev-compose.js")
  const audit = await composeAuditArgs(cwd, config)
  const gate = () => requireDockerFeatures(cwd, config, [OVERWRITE_DRIFT_NEED])
  if (run.overwriteDrift) await gate()
  const engine: DockerPushEngine = hasEngineOverride(config) ? "host" : "compose"
  const applying = (overwriteDrift: boolean) =>
    pushConsentingToDestructive(
      (force) =>
        withSpinner(dockerApplyMessage(force, engine), () =>
          pushSchemaDocker(cwd, config, { overwriteDrift, force, audit }),
        ),
      { yes: run.yes, apply: "supatype push --yes" },
      consentDepsFromDiff(cwd, () => dockerDiff(cwd, config)),
    )
  await pushOfferingAdoption(
    () => pushConsentingToDrift(applying, run, { beforeOverwrite: gate }),
    dockerAdoptionSteps(cwd, config),
    { yes: run.yes, retry: "supatype push" },
  )
}

/** How this push was asked to treat what needs a person's say. */
export interface PushRun {
  /** `--yes`: skip the prompts. */
  yes: boolean
  /** `--overwrite-drift`: put back access changed outside Supatype without asking (plan 3.5). */
  overwriteDrift: boolean
}

/**
 * Plan 3.5: access changed or removed outside Supatype is put back only with consent. Shows each
 * object, then asks when a person is there; a push that cannot ask stops, since a pipeline must not
 * revert a deliberate hand edit and a rollback could not bring it back. Returns whether to
 * overwrite, or `null` when the push should not go ahead.
 */
export async function consentToSecurityDrift(
  diff: Pick<DiffResult, "reconcile">,
  run: PushRun,
): Promise<boolean | null> {
  if (run.overwriteDrift) return true
  const drifted = securityDrift(diff)
  if (drifted.length === 0) return false
  plain(`\n${drifted.length} object(s) that decide who may read or write were changed outside Supatype:\n`)
  for (const line of formatSecurityDrift(drifted)) plain(line)
  if (run.yes || !isInteractive()) {
    plain(
      "\nNothing was applied. Run the push interactively to review this, or pass --overwrite-drift to put Supatype's definitions back.",
    )
    process.exitCode = 1
    return null
  }
  return (await askToOverwrite()) ? true : null
}

async function pushViaTarget(
  cwd: string,
  config: SupatypeProjectConfig,
  target: DeployTarget,
  ast: unknown,
  pgSchema: string,
  run: PushRun,
): Promise<void> {
  // Before anything is read or asked: a server or engine that cannot honour the flag says so now.
  if (run.overwriteDrift) await requireTargetFeatures(target, [OVERWRITE_DRIFT_NEED])
  if (!(await databaseIsReady(cwd, config, target, ast))) return
  const plan = (schema: unknown) =>
    withSpinner("Diffing against database", () => targetSchemaDiff(target, schema, { schema: pgSchema }))
  let diff = await plan(ast)
  // A rename recorded is a different schema: built and planned again, with the journal carrying it.
  if (await recordedRenames(cwd, diff, run)) {
    ast = pushAst(cwd, config)
    diff = await plan(ast)
  }
  // The differ's operations and the reconcile's changes together: a push with only reconciled
  // objects to change still applies a migration, and is confirmed like any other.
  const changes = plannedChanges(diff)
  printDiffWarnings(diff)

  if (changes.length === 0) {
    info("Schema matches the database (no DDL). Syncing Studio metadata...")
  } else {
    printDiffOperations(diff)
    const risky = changes.filter(isRisky)
    if (risky.length > 0 && !run.yes) {
      if (!isInteractive()) {
        logSkippedConfirm(`${risky.length} risky change(s) require confirmation`)
        plain("Aborted.")
        return
      }
      const confirmed = await confirm(
        `${risky.length} risky change(s) above. Proceed?`,
        { default: false },
      )
      if (!confirmed) {
        plain("Aborted.")
        return
      }
    }
  }

  const overwriteDrift = await consentToSecurityDrift(diff, run)
  if (overwriteDrift === null) return
  // Consent given at the prompt rather than by the flag still sends the flag.
  if (overwriteDrift && !run.overwriteDrift) {
    await requireTargetFeatures(target, [OVERWRITE_DRIFT_NEED])
  }

  const pushResult = await applyToTarget(cwd, { target, ast, pgSchema }, { ...run, overwriteDrift }, changes.length > 0)
  // Declined at the drift question: nothing more was applied, and that was said.
  if (pushResult === undefined) return

  if ((pushResult as { status?: string }).status === "up_to_date") {
    info("Schema is up to date.")
  } else {
    info((pushResult as { message?: string }).message ?? "Migration applied.")
    const migrationName = (pushResult as { name?: string }).name
    const schemaSources = buildSchemaSourcesPayload(cwd)
    if (migrationName && schemaSources) {
      cacheSchemaSourcesLocally(cwd, migrationName, schemaSources.gz)
    }
  }
  // The diff's were printed before applying; what is left is what the push found once applied.
  printPushWarnings(pushResult, diff.warnings ?? [])

  if (target.mode === "cloud" || target.mode === "self-host") {
    await deployHooksToTarget(cwd, config, target, ast)
  }
  // A linked self-host server runs the same compose stack, with the same PostgREST to wait for.
  if (target.mode === "self-host") await waitForRestReady(target.apiBaseUrl, undefined)

  if (target.mode === "direct" || target.mode === "local") {
    await finishLocalPush(cwd, config, target, ast)
    return
  }

  info(`Pushed to ${target.mode} (${target.environment}).`)
  // Cloud only. A self-host control plane has tiers too and they mean nothing there, so the same
  // sentence would be telling a self-hosted project to upgrade something it already has.
  if (target.mode === "cloud") {
    const note = freeTierCacheNote((pushResult as { cache?: { tables?: string[]; honoured?: boolean } }).cache)
    if (note) info(note)
  }
  const envUrl = target.link?.environments?.[target.environment]?.apiUrl?.replace(/\/$/, "")
  if (envUrl) {
    plain(`\nProject API: ${envUrl}`)
  }
}

/**
 * The renames the diff offers, settled as every push settles them (`settleRenames`): asked about in
 * a terminal, each yes recorded in the rename journal, or named with the command that records them
 * anywhere else. True when one was recorded. `--yes` asks nothing: it is consent to the push as it
 * stands.
 */
async function recordedRenames(cwd: string, diff: DiffResult, run: PushRun): Promise<boolean> {
  if (run.yes) return false
  const ask = (question: string) => confirm(question, { default: false })
  const settled = await settleRenames(consentDepsFromDiff(cwd, async () => diff), isInteractive(), ask)
  for (const line of settled.hint) plain(line)
  return settled.written > 0
}

/**
 * Push to `to`, offering adoption when it refuses unmanaged tables. `run.overwriteDrift` is the
 * consent already given, by the flag or at the diff's question.
 *
 * The diff can be clean and the push still refused over access: a hand edit can land while the
 * person reads the diff (C08). That refusal is asked about as the diff's drift is, and a yes pushes
 * again with consent. Undefined when the person said no.
 */
function applyToTarget(
  cwd: string,
  to: { target: DeployTarget; ast: unknown; pgSchema: string },
  run: PushRun,
  migrating: boolean,
): Promise<Awaited<ReturnType<typeof targetSchemaPush>> | undefined> {
  const { target, ast, pgSchema } = to
  const applying = (overwriteDrift: boolean) =>
    withSpinner(migrating ? "Applying migration" : "Syncing with engine", () =>
      targetSchemaPush(target, ast, {
        cwd,
        force: true,
        schema: pgSchema,
        schemaSources: buildSchemaSourcesPayload(cwd),
        overwriteDrift,
      }),
    )
  return pushOfferingAdoption(
    () => pushConsentingToDrift(applying, run, { beforeOverwrite: () => requireTargetFeatures(target, [OVERWRITE_DRIFT_NEED]) }),
    targetAdoptionSteps(
      (yes, keys) => targetSchemaAdopt(target, ast, { schema: pgSchema, yes, ...(keys !== undefined && { keys }) }),
      // Before anyone is asked: applying sends the previewed keys, which this target must honour.
      (keys) => requireTargetFeatures(target, [adoptKeysNeed(keys)]),
    ),
    { yes: run.yes, retry: "supatype push" },
  )
}

/**
 * After a push the engine ran here: the admin config, the first admin, the generated files, and,
 * for the project's own running stack only, its storage buckets and Studio link.
 *
 * A push to some other database (`--connection`, or an external one) has no stack of this project
 * behind it. It used to provision buckets and print a Studio link on the default gateway port,
 * which is another project's on a machine running two (A3-N4, A4-N2).
 */
async function finishLocalPush(cwd: string, config: SupatypeProjectConfig, target: DeployTarget, ast: unknown): Promise<void> {
  await writeLocalAdminConfig(ast, config)
  const stackUrl = projectStackUrl(cwd, config, target.databaseUrl)
  const studioUrl = stackUrl === undefined ? undefined : studioUrlAt(stackUrl)
  if (target.databaseUrl) {
    await ensureFirstAdminUser(target.databaseUrl, { cwd, studioUrl })
  }
  await generateTypesLocal(ast, config, isProjectDatabase(cwd, config, target.databaseUrl))
  if (stackUrl !== undefined && resolveRuntimeProvider(config) === "docker") {
    // A push to the running stack's database can change its tier (T2-N6), and PostgREST follows.
    const { followRecordedTier } = await import("../dev-compose.js")
    followRecordedTier(cwd, config, { recreate: true })
  }
  if (stackUrl !== undefined) await provisionLocalStorage(ast, config, stackUrl)
  if (stackUrl !== undefined && resolveRuntimeProvider(config) === "docker") {
    await waitForRestReady(stackUrl, devApiKeys(cwd).anonKey)
  }
  reportCacheSeeding(cwd, ast)
  if (studioUrl !== undefined) plain(`\nStudio: ${studioUrl}`)
}

/**
 * For a database this project does not run, whether it has what the push needs, saying what is
 * missing and how to add it when not (T2-N11). The project's own database always does.
 */
async function databaseIsReady(
  cwd: string,
  config: SupatypeProjectConfig,
  target: DeployTarget,
  ast: unknown,
): Promise<boolean> {
  if (target.mode !== "direct" || target.databaseUrl === undefined) return true
  if (isProjectDatabase(cwd, config, target.databaseUrl)) return true
  const gaps = await byoPreflight(target.databaseUrl, ast)
  if (gaps.length === 0) return true
  plain("\nThis database is missing what Supatype needs. Nothing was applied.\n")
  for (const line of gaps) plain(line)
  process.exitCode = 1
  return false
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
    fatalError(errorMessage(err))
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

/**
 * Switch on what the schema newly declares, and say what is still in the way.
 *
 * Two things have to be true for a local `.cache({ server: true })` to be served: the schema
 * declares the table, and the runtime allowlist has it on. A push writes the first, so without
 * this the second is a trip to Studio that nothing in the output asks for, the symptom being a
 * BYPASS header and a declaration that appears to do nothing.
 *
 * Never an error, and never a rewrite of an entry that already exists. See `seedApiConfigCache`.
 */
function reportCacheSeeding(cwd: string, ast: unknown): void {
  for (const note of cacheSeedingNotes(cwd, ast)) info(note)
}

/** The generated adapter, flattened to the name handlers were rewritten to import. */
function readGeneratedAdapter(hooksDir: string): { name: string; source: string } | null {
  const file = join(hooksDir, "_supatype", "hooks.ts")
  if (!existsSync(file)) return null
  return adapterEntry(readFileSync(file, "utf8"))
}

async function generateTypesLocal(ast: unknown, config: SupatypeProjectConfig, ownDatabase: boolean): Promise<void> {
  // Independent of `output`: a project with hooks needs its handler types whether or not it asked
  // for client types, and the module is written next to the functions that import it.
  const cwd = process.cwd()
  const hooksPath = writeHooksModule(cwd, hooksPathFromProject(config, cwd), ast)
  if (hooksPath !== null) info(`Hook handler types written to ${hooksPath}`)

  // `_shared/context.ts` too, for the same reason the hook module is here.
  //
  // It was written by `init` and `functions new` and by nothing else, so a project that predates
  // the two-argument handler contract never received it: its functions had no `FunctionContext` to
  // import, while the file itself claims "Regenerated by the CLI. Edits are overwritten." That
  // claim was only true if you scaffolded again. `tests/integration` had four functions and no
  // context module at all.
  if (refreshFunctionsContext(cwd, config)) {
    info("Function context type written to functions/_shared/context.ts")
  }
  // The server watches this file, so a changed hook takes effect without a restart.
  if (syncManifestHooks(cwd, ast)) info("Hook map written to .supatype/manifest.json")
  // The row cache is configured at postmaster start, so this is the one cache setting a push
  // cannot make take effect on its own. Only for the project's own database: `.env` configures that
  // container, and a push to any other database has no container to recreate (A2-N4).
  const rowCache = ownDatabase ? syncRowCacheEnv(cwd, ast) : null
  if (rowCache !== null) {
    info(
      `${rowCacheChangeNote(rowCache)} Recreate the database container for it to take ` +
        "effect: the image writes pg_keyspace.conf at start, so a running Postgres keeps the " +
        "setting it booted with.",
    )
  }

  // The CLI writes these, it does not ask the engine to. Passing types_path and client_path and
  // reading only `message` meant the generated TypeScript was printed to the terminal and no file
  // was ever created, so `push` reported success and produced nothing. Written at the default
  // paths when `output` is not set: a client left describing the old schema compiles against
  // columns that no longer exist.
  const written = await withSpinner("Generating types", () =>
    writeGeneratedTypes({ cwd, ast, ...projectOutputPaths(config.output) }),
  )
  for (const message of written) info(message)
}

/** Create the schema's buckets on the project's own stack at `baseUrl`. */
async function provisionLocalStorage(ast: unknown, config: SupatypeProjectConfig, baseUrl: string): Promise<void> {
  const serviceRoleKey = localServiceRoleKey(config)
  if (!serviceRoleKey) return
  await ensureEngine()
  const parsedAst = await engineRequest("/parse", { ast }, isParsedBuckets)
  await provisionBucketsFromAst(parsedAst, `${baseUrl}/storage/v1`, serviceRoleKey)
}

/**
 * The service-role key for the project's own stack: one the shell exported, as that stack accepts
 * it, else the key that stack was configured with. Docker and native dev both run with the
 * project's own `JWT_SECRET` from `.env`, so the key comes from there for either. Signing one with
 * the published dev secret was refused by every stack with a secret of its own.
 */
export function localServiceRoleKey(config: SupatypeProjectConfig): string | undefined {
  const explicit = shellServiceRoleKey(process.cwd())
  if (explicit) return explicit
  if (config.server.mode !== "dev") return undefined
  return devApiKeys(process.cwd()).serviceRoleKey
}

async function writeLocalAdminConfig(ast: unknown, config: SupatypeProjectConfig): Promise<void> {
  const cwd = process.cwd()
  const dir = join(cwd, ".supatype")
  mkdirSync(dir, { recursive: true })
  await ensureEngine()
  const admin = withAdminRoles(await engineRequest("/admin", { ast }), config)
  restoreSystemRelationTargets(admin, ast)
  writeFileSync(join(dir, "admin-config.json"), `${JSON.stringify(admin, null, 2)}\n`)
}

/**
 * Stop the push when a preview address could never open.
 *
 * Refused here rather than left to fail later, because later means in front of whoever was sent the
 * link, not in front of whoever configured it.
 */
function assertPreviewAddressesResolve(config: SupatypeProjectConfig): void {
  const models = modelsWithUnresolvablePreview(config)
  if (models.length === 0) return
  fatalError(unresolvablePreviewMessage(models), [
    'Give an absolute URL: urlPattern: "https://example.com/preview/{slug}"',
    'Or set app.mode to "static" or "proxy", if this deployment should serve the app.',
  ])
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
