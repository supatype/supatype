/**
 * `supatype seed`: find the seed files, collect what they describe, hand it to the engine.
 *
 * Discovery and collection are what this command already did. The rest is new only in that it
 * collects rather than executes: no connection handling, no SQL, no transaction, no error mapping,
 * because those are the engine's now and six more language runners should not each reimplement
 * them and disagree.
 *
 * Where the documents go depends on the target. A project linked to Supatype Cloud or a self-hosted
 * server sends them to its control plane (`seed-remote.ts`), which runs the engine as the
 * environment's role. Any other project, `--local`, and `--connection` run the engine here against a
 * database this machine can reach.
 *
 * Both module shapes are supported locally. A default-exported function is the new contract and is
 * handed a context; a module with no default export is the old one, which does its work on
 * import and is told so by name. A linked project accepts only the new one.
 */

import type { Command } from "commander"
import { isLinkedToCloudProject, pinnedVersion } from "../binary-cache.js"
import { loadConfig, loadSchemaAst, type SupatypeConfig } from "../config.js"
import type { ComposeEngine } from "../engine-client.js"
import { engineRequestIn, stackEngine } from "../stack-engine.js"
import { seedUnsupportedByPinnedEngine } from "../engine-floor.js"
import { withPublishing } from "../model-versioning.js"
import { pgSchema, schemaPathFromProject } from "../project-config.js"
import { redact, resolveHostDatabaseUrl } from "../host-database.js"
import { requireLocalStack } from "../local-stack-guard.js"
import { errorMessage } from "../error-message.js"
import {
  collectPrepared,
  existingSeedPaths,
  locateBuilder,
  runOnceForAll,
  seedDocuments,
  type Prepared,
} from "../seed-prepare.js"
import { isSeedResult, isSeedStatus, report, reportSeedStatus } from "../seed-report.js"
import { linkedTarget, runRemoteSeed } from "../seed-remote.js"
import { error, info, warn } from "../ui/messages.js"

export { discoverSeedsDir, seedPaths } from "../seed-prepare.js"
export { reportSeedStatus, seedFailureText } from "../seed-report.js"

export interface SeedFlags {
  /** Refused on a linked project (see `--confirm-production`); has no other meaning. */
  force: boolean
  atomic: boolean
  status: boolean
  connection?: string
  environment?: string
  /** The linked environment to seed. */
  env?: string
  /** Seed the stack on this machine even when the project is linked. */
  local?: boolean
  /** Confirms a seed of a linked project's production environment without the prompt. */
  confirmProduction?: boolean
}

export function registerSeed(program: Command): void {
  program
    .command("seed [file]")
    .description(
      "Run database seeds: optional single file; else all seeds/*.ts (alphabetical); else seed.ts",
    )
    .option(
      "--force",
      "Refused on a linked project: use --confirm-production for production, --local for the local stack",
      false,
    )
    .option("--atomic", "Run every seed file in one transaction", false)
    .option("--status", "Show what has been applied, and what has changed since", false)
    .option("--connection <dsn>", "Database to seed with the engine on this machine, instead of the resolved one")
    .option(
      "--environment <name>",
      "Name an `environment` condition reads. On a linked project it is the target environment, and must match it",
    )
    .option("--env <name>", "Environment to seed on a linked project (default: the linked default)")
    .option("--local", "Seed the local stack even when the project is linked", false)
    .option("--confirm-production", "Seed a linked project's production environment without the prompt", false)
    .action(async (file: string | undefined, opts: SeedFlags) => {
      const code = await runSeed(file, opts)
      if (code !== 0) process.exit(code)
    })
}

/**
 * Separated from the action so the exit code is a value rather than a side effect.
 *
 * `0` applied, `1` a seed failed, `2` the run could not start. The split is what lets CI
 * retry one and not the other.
 */
export async function runSeed(file: string | undefined, opts: SeedFlags): Promise<number> {
  const cwd = process.cwd()
  const config = loadConfig(cwd)

  if (opts.local !== true && opts.connection === undefined) {
    const linked = linkedProject(cwd, config, opts)
    if (typeof linked === "number") return linked
    if (linked !== undefined) return await runRemoteSeed(file, opts, linked, config)
  }
  return await runLocalSeed(file, opts, cwd, config)
}

/**
 * The linked control plane to seed through, or undefined for the engine here, or an exit code when
 * the project is marked as linked in a way that has no control plane to ask.
 */
function linkedProject(cwd: string, config: SupatypeConfig, opts: SeedFlags): ReturnType<typeof linkedTarget> | number {
  try {
    const target = linkedTarget(cwd, opts.env)
    if (target !== undefined || !isLinkedToCloudProject(cwd, config)) return target
  } catch (e) {
    error(errorMessage(e))
    return 2
  }
  error(
    "This project is marked as linked to Supatype Cloud (project.ref), but has no link to seed through.\n" +
      "  Run `supatype link`, or pass --local to seed the stack on this machine.",
  )
  return 2
}

/** The engine here, against the local stack or the database `--connection` names. */
async function runLocalSeed(
  file: string | undefined,
  opts: SeedFlags,
  cwd: string,
  config: SupatypeConfig,
): Promise<number> {
  // Before the connection is resolved and before a builder is looked for: an engine that cannot
  // seed makes both of those pointless, and the pin is the cheapest thing here to read.
  const tooOld = seedUnsupportedByPinnedEngine(pinnedVersion("engine", config))
  if (tooOld !== undefined) {
    error(tooOld)
    return 2
  }

  const dsn = localDatabaseUrl(cwd, config, opts)
  if (dsn === undefined) return 2
  const engine = await stackEngine(cwd, config, opts.connection, dsn)
  if (opts.status) return await reportStatus(dsn, engine)

  const collected = collectLocal(file, opts, cwd, config)
  if (typeof collected === "number") return collected
  if (collected.length === 0) {
    info("No seed operations to apply.")
    return 0
  }
  return await apply(collected, { cwd, config, dsn, opts, engine })
}

/** The database the engine here seeds, or undefined after saying why there is none. */
function localDatabaseUrl(cwd: string, config: SupatypeConfig, opts: SeedFlags): string | undefined {
  try {
    // A stack that is not running is the environment not set up, so 2 as for any other.
    requireLocalStack(cwd, config, "seed", { connection: opts.connection, direct: true })
    return resolveHostDatabaseUrl(cwd, config, { connection: opts.connection, allowDerived: true }).dsn
  } catch (e) {
    // DsnNotFound and NoStackRunning say what to do in their message; the class name adds nothing.
    error(errorMessage(e))
    return undefined
  }
}

/** The files' collected documents, or the exit code of a run that could not collect them. */
function collectLocal(file: string | undefined, opts: SeedFlags, cwd: string, config: SupatypeConfig): Prepared[] | number {
  const paths = existingSeedPaths(file, cwd, config)
  if (paths === undefined) return 2
  const builderPath = locateBuilder(cwd, config)
  if (builderPath === undefined) return 2

  const collection = collectPrepared(paths, { cwd, builderPath, environment: opts.environment })
  if ("failed" in collection) return collection.failed
  for (const label of collection.legacy) {
    warn(
      `${label} has no default export, so it ran on import.
` +
        "  Export a default function to have its writes collected, ordered and applied in one transaction.",
    )
  }
  return collection.prepared
}

// --- Applying ---

interface ApplyOptions {
  cwd: string
  config: SupatypeConfig
  dsn: string
  opts: SeedFlags
  /** The compose engine to run in, or undefined for the host binary ({@link stackEngine}). */
  engine: ComposeEngine | undefined
}

async function apply(prepared: Prepared[], options: ApplyOptions): Promise<number> {
  const { cwd, config, dsn, opts, engine } = options
  const ast = withPublishing(loadSchemaAst(schemaPathFromProject(config, cwd), cwd), config)
  let documents: string[]
  try {
    documents = seedDocuments(prepared, ast)
  } catch (e) {
    error(errorMessage(e))
    return 1
  }

  const result = await engineRequestIn(engine, "/seed", {
    ast,
    ir_documents: documents,
    database_url: dsn,
    schema: pgSchema(config),
    atomic: opts.atomic,
    run_once: runOnceForAll(prepared),
    ...(opts.environment !== undefined ? { environment: opts.environment } : {}),
  }, isSeedResult)

  return report(result, prepared.length, redact(dsn))
}

async function reportStatus(dsn: string, engine: ComposeEngine | undefined): Promise<number> {
  return reportSeedStatus(await engineRequestIn(engine, "/seed", { database_url: dsn, status: true }, isSeedStatus), dsn)
}
