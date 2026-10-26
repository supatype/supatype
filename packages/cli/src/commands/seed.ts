/**
 * `supatype seed`: find the seed files, collect what they describe, hand it to the engine.
 *
 * Discovery and the Cloud guard are what this command already did. The rest is new only in
 * that it collects rather than executes: no connection handling, no SQL, no transaction, no
 * error mapping, because those are the engine's now and six more language runners should not
 * each reimplement them and disagree.
 *
 * Both module shapes are supported. A default-exported function is the new contract and is
 * handed a context; a module with no default export is the old one, which does its work on
 * import and is told so by name. Nothing here removes the old shape.
 */

import type { Command } from "commander"
import { existsSync, readdirSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { isLinkedToCloudProject, pinnedVersion } from "../binary-cache.js"
import { loadConfig, loadSchemaAst, type SupatypeConfig } from "../config.js"
import { engineRequest, ensureEngine, type ComposeEngine } from "../engine-client.js"
import { DEFAULT_DB_PORT, isLocalDatabaseUrl } from "../db-port.js"
import { composeRenderMode } from "../compose-render-mode.js"
import {
  isArrayOf,
  isBoolean,
  isNumber,
  isRecordOf,
  isShape,
  isString,
  nullable,
  optional,
  type Guard,
} from "@supatype/shared"
import { seedUnsupportedByPinnedEngine } from "../engine-floor.js"
import { pgSchema, projectRootFromConfig, schemaPathFromProject } from "../project-config.js"
import { composeDbHostPort, redact, resolveHostDatabaseUrl } from "../host-database.js"
import { collectSeed, SeedCollectionFailed } from "../seed-runner.js"
import { seedBuilderPathWithDefaults } from "../type-generation.js"
import type { SeedConfig, SeedIr } from "../seed.js"
import { error, info, success, warn } from "../ui/messages.js"

const SEED_EXT = /\.(ts|mts|tsx)$/

/** Seed entries under `seeds/`, sorted by filename. */
export function discoverSeedsDir(cwd: string, seedsDir: string): string[] {
  if (!existsSync(seedsDir)) return []
  const names = readdirSync(seedsDir).filter((n) => SEED_EXT.test(n))
  names.sort((a, b) => a.localeCompare(b))
  return names.map((n) => join(seedsDir, n))
}

/** One file's worth of collected IR, with what that file asked for. */
interface Prepared {
  file: string
  document: SeedIr
  config: SeedConfig
}

export interface SeedFlags {
  force: boolean
  atomic: boolean
  status: boolean
  connection?: string
  environment?: string
}

export function registerSeed(program: Command): void {
  program
    .command("seed [file]")
    .description(
      "Run database seeds: optional single file; else all seeds/*.ts (alphabetical); else seed.ts",
    )
    .option(
      "--force",
      "Allow running when the project is linked to Supatype Cloud (dangerous)",
      false,
    )
    .option("--atomic", "Run every seed file in one transaction", false)
    .option("--status", "Show what has been applied, and what has changed since", false)
    .option("--connection <dsn>", "Database to seed, instead of the resolved one")
    .option("--environment <name>", "Environment name, for an `environment` condition")
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

  if (isLinkedToCloudProject(cwd, config) && !opts.force) {
    error(
      "This project is linked to Supatype Cloud. Refusing to run seeds locally.\n" +
        "  Pass --force only if you intend to target this linked project (advanced).",
    )
    return 2
  }

  // Before the connection is resolved and before a builder is looked for: an engine that cannot
  // seed makes both of those pointless, and the pin is the cheapest thing here to read.
  const tooOld = seedUnsupportedByPinnedEngine(pinnedVersion("engine", config))
  if (tooOld !== undefined) {
    error(tooOld)
    return 2
  }

  let dsn: string
  try {
    dsn = resolveHostDatabaseUrl(cwd, config, {
      connection: opts.connection,
      allowDerived: true,
    }).dsn
  } catch (e) {
    // DsnNotFound and NoStackRunning say what to do in their message; the class name adds nothing.
    error(e instanceof Error ? e.message : String(e))
    return 2
  }

  const engine = await seedEngine(cwd, config, opts.connection, dsn)
  if (engine === undefined) await ensureEngine()
  if (opts.status) return await reportStatus(dsn, engine)

  const paths = seedPaths(file, cwd, config)
  const missing = paths.filter((p) => !existsSync(p))
  if (missing.length > 0) {
    error(`Seed file(s) not found:\n  ${missing.join("\n  ")}`)
    return 2
  }

  const builderPath = locateBuilder(cwd, config)
  if (builderPath === undefined) return 2

  const prepared: Prepared[] = []
  for (const path of paths) {
    const label = toPosix(relative(cwd, path))
    let collected
    try {
      collected = collectSeed(path, {
        cwd,
        builderPath,
        environment: opts.environment,
      })
    } catch (e) {
      error(e instanceof SeedCollectionFailed ? e.message : String(e))
      return 1
    }

    if (collected.stdout.trim().length > 0) {
      for (const line of collected.stdout.trimEnd().split(/\r?\n/)) info(`  ${label}: ${line}`)
    }
    if (collected.result.shape === "legacy") {
      warn(
        `${label} has no default export, so it ran on import.\n` +
          "  Export a default function to have its writes collected, ordered and applied in one transaction.",
      )
      continue
    }
    prepared.push({
      file: label,
      document: collected.result.ir,
      config: collected.result.config,
    })
  }

  if (prepared.length === 0) {
    info("No seed operations to apply.")
    return 0
  }

  return await apply(prepared, { cwd, config, dsn, opts, engine })
}

/**
 * The engine a seed runs: the project's compose engine image when it seeds the project's own stack
 * database, as push does, otherwise the host binary (undefined). Seed used to run the host binary
 * always, so a stale cached one refused a schema the compose engine had just pushed.
 *
 * Only for the stack's own database: the compose engine reaches it inside the stack network, so a
 * `--connection` or a database on another machine stays with the host binary, which connects to
 * the URL it was given.
 */
export async function seedEngine(
  cwd: string,
  config: SupatypeConfig,
  connection: string | undefined,
  dsn: string,
): Promise<ComposeEngine | undefined> {
  if (connection !== undefined && connection.trim() !== "") return undefined
  if (!isStackDatabaseUrl(cwd, config, dsn)) return undefined
  const { projectComposeEngine } = await import("../dev-compose.js")
  return projectComposeEngine(cwd, config)
}

/**
 * True when `dsn` is the stack's own database as the host reaches it: on this machine, at the port
 * the stack's layout publishes Postgres on. A local URL at any other port is another Postgres, which
 * the compose engine, connecting inside the stack network, would not be seeding.
 */
function isStackDatabaseUrl(cwd: string, config: SupatypeConfig, dsn: string): boolean {
  if (!isLocalDatabaseUrl(dsn)) return false
  const port = new URL(dsn).port || String(DEFAULT_DB_PORT)
  return port === String(composeDbHostPort(cwd, composeRenderMode(cwd, config.project.name)))
}

// --- Discovery ---

function seedPaths(file: string | undefined, cwd: string, config: SupatypeConfig): string[] {
  if (file !== undefined && file.trim() !== "") return [resolve(cwd, file)]
  const root = projectRootFromConfig(config, cwd)
  const fromDir = discoverSeedsDir(cwd, join(root, "seeds"))
  return fromDir.length > 0 ? fromDir : [resolve(root, "seed.ts")]
}

/**
 * The generated builder, which the runtime needs for the manifest and the fingerprint.
 *
 * Absent is a setup problem with a one-line remedy rather than a crash: the builder is
 * gitignored by design, so a fresh clone that has not run `generate` is the ordinary case.
 */
function locateBuilder(cwd: string, config: SupatypeConfig): string | undefined {
  const relativePath = seedBuilderPathWithDefaults(config.output)
  const path = resolve(cwd, relativePath)
  if (!existsSync(path)) {
    error(
      `The generated seed builder is missing: ${toPosix(relativePath)}\n` +
        "  Run `supatype generate`. It needs no database and no running stack.",
    )
    return undefined
  }
  return path
}

// --- Applying ---

interface ApplyOptions {
  cwd: string
  config: SupatypeConfig
  dsn: string
  opts: SeedFlags
  /** The compose engine to run in, or undefined for the host binary ({@link seedEngine}). */
  engine: ComposeEngine | undefined
}

async function apply(prepared: Prepared[], options: ApplyOptions): Promise<number> {
  const { cwd, config, dsn, opts, engine } = options
  const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)

  // The engine takes one `--run-once` for the run, so a file asking for it decides for all
  // of them. Said out loud rather than generalised silently, because the difference is
  // whether work someone expected to happen happens.
  const askedRunOnce = prepared.filter((one) => one.config.runOnce === true)
  if (askedRunOnce.length > 0 && askedRunOnce.length !== prepared.length) {
    warn(
      "Some seed files declare `runOnce` and others do not, and the run takes one setting.\n" +
        `  Applying it to all of them, because ${askedRunOnce
          .map((one) => one.file)
          .join(", ")} asked for it.`,
    )
  }

  const result = await engineRequest("/seed", {
    ast,
    ir_documents: prepared.map((one) => JSON.stringify({ ...one.document, file: one.file })),
    database_url: dsn,
    schema: pgSchema(config),
    atomic: opts.atomic,
    run_once: askedRunOnce.length > 0,
    ...(opts.environment !== undefined ? { environment: opts.environment } : {}),
  }, isSeedResult, engine)

  return report(result, prepared.length, dsn)
}

interface SeedResult {
  ok: boolean
  atomic?: boolean
  files?: Array<{
    file: string
    status: string
    written?: Record<string, number>
    skippedGroups?: string[]
  }>
  error?: {
    kind: string
    message?: string
    remedy?: string | null
    file?: string
    path?: string
  }
}

/**
 * Print what happened to every file, then the outcome.
 *
 * Every file, not just the one that failed: without `--atomic` a failure in the third of
 * five leaves the first two committed, and a report that mentioned only the failure would
 * leave the reader to guess at the rest.
 */
/** The engine's seed result document (schema-engine `seed_command`). */
const isSeedResult: Guard<SeedResult> = isShape({
  ok: isBoolean,
  atomic: optional(isBoolean),
  files: optional(
    isArrayOf(
      isShape({
        file: isString,
        status: isString,
        written: optional(isRecordOf(isNumber)),
        skippedGroups: optional(isArrayOf(isString)),
      }),
    ),
  ),
  error: optional(
    isShape({
      kind: isString,
      message: optional(isString),
      remedy: optional(nullable(isString)),
      file: optional(isString),
      path: optional(isString),
    }),
  ),
})

/** `seed --status`: the latest run of each file, and whether it has changed since. */
const isSeedStatus = isShape({
  files: optional(
    isArrayOf(
      isShape({ file: isString, appliedAt: isString, status: isString, durationMs: isNumber, drifted: isBoolean }),
    ),
  ),
})

function report(result: SeedResult, count: number, dsn: string): number {
  for (const file of result.files ?? []) {
    const rows = Object.entries(file.written ?? {})
      .map(([model, written]) => `${model} ${written}`)
      .join(", ")
    info(`  ${file.file.padEnd(32)} ${file.status}${rows.length > 0 ? `  (${rows})` : ""}`)
    for (const skipped of file.skippedGroups ?? []) {
      info(`    condition was false, skipped: ${skipped}`)
    }
  }

  if (result.ok) {
    success(`Seeded ${count} file(s) into ${redact(dsn)}.`)
    return 0
  }

  const failure = result.error
  if (failure === undefined) {
    error("The seed failed, and the engine said nothing about why.")
    return 1
  }

  const where = [failure.file, failure.path].filter((part) => part !== undefined && part !== "")
  error(
    (failure.message ?? failure.kind) +
      (where.length > 0 ? `\n  at ${where.join(" ")}` : "") +
      (failure.remedy !== undefined && failure.remedy !== null ? `\n  ${failure.remedy}` : ""),
  )
  // Nothing ran because nothing could: the environment, not the seed.
  return failure.kind === "connection" || failure.kind === "document" ? 2 : 1
}

async function reportStatus(dsn: string, engine: ComposeEngine | undefined): Promise<number> {
  const result = await engineRequest("/seed", { database_url: dsn, status: true }, isSeedStatus, engine)

  const files = result.files ?? []
  if (files.length === 0) {
    info(`No seeds have been applied to ${redact(dsn)}.`)
    return 0
  }

  for (const entry of files) {
    info(
      `  ${entry.file.padEnd(32)} ${entry.status.padEnd(12)} ${entry.appliedAt}  ` +
        `${entry.durationMs}ms${entry.drifted ? "  changed since it was applied" : ""}`,
    )
  }
  return 0
}

/** Reported with forward slashes, so the message reads the same on every platform. */
function toPosix(path: string): string {
  return path.split(sep).join("/")
}
