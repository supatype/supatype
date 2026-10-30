import { withPublishing } from "../model-versioning.js"
import type { Command } from "commander"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { printPushWarnings, type EnginePushResult } from "../engine-push-output.js"
import { loadConfig, loadSchemaAst } from "../config.js"
import { projectRootFromConfig, schemaPathFromProject } from "../project-config.js"
import { resolveHostDatabaseUrl } from "../host-database.js"
import { ensureEngine, engineRequest } from "../engine-client.js"
import { isEnginePushResult, isMigrateAnswer } from "../engine-answers.js"
import { plannedChanges } from "../diff-output.js"
import { loadProjectLink } from "../link.js"
import {
  resolveTarget,
  targetSchemaDiff,
  targetSchemaRollback,
  targetListMigrations,
  schemaPgSchema,
  type DeployTarget,
  type MigrationListEntry,
  type SchemaRollbackResult,
} from "../resolve-target.js"
import {
  restoreSchemaSourcesFromGz,
  findOrphanSchemaFiles,
  isSchemaSourcesManifest,
} from "../schema-sources.js"
import { renameLabel } from "../rename-journal.js"
import { confirm } from "../ui/confirm.js"
import { info, plain, warn } from "../ui/messages.js"

/**
 * What `rollback` does with the schema files, from its `--sync-schema` / `--no-sync-schema` pair.
 *
 * Commander reports the pair as one `syncSchema` value: true, false, or unset. The action used to
 * read a `noSyncSchema` key Commander never sets, so `--no-sync-schema` fell through to the restore
 * offer, which a non-interactive run accepts, and rewrote the files it was asked to keep.
 */
export function schemaRestoreMode(opts: { syncSchema?: boolean }): "skip" | "auto" | "ask" {
  if (opts.syncSchema === false) return "skip"
  return opts.syncSchema === true ? "auto" : "ask"
}

/** `supatype migrate`'s options. */
export interface MigrateOptions {
  connection?: string
  /** Rehearse the push so the file records it too (IN-A). Takes a push's locks while it runs. */
  record?: boolean
  force?: boolean
  output?: string
}

/** The engine's answer: the binary prints the SQL, which arrives as `message`; a server sends `sql`. */
export interface MigrateResult {
  sql?: string
  message?: string
}

/** The `/migrate` request for `opts`: `record` and `force` only when asked for. */
export function migrateRequest(
  ast: unknown,
  databaseUrl: string,
  schema: string,
  opts: Pick<MigrateOptions, "record" | "force">,
): Record<string, unknown> {
  return {
    ast,
    database_url: databaseUrl,
    schema,
    force: opts.force === true,
    record: opts.record === true,
  }
}

/** The SQL from the engine's answer, or an error when it sent none. */
export function migrationSql(result: MigrateResult): string {
  const sql = result.sql ?? result.message
  if (sql === undefined || sql.trim() === "") {
    throw new Error("The engine returned no SQL for this migration.")
  }
  return sql.trimEnd()
}

/** Where `migrations list` and `rename --prune` read the history from. */
export interface MigrationsTargetOptions {
  connection?: string
  env?: string
  direct?: boolean
}

/** The linked environment, unless `--direct` or `--connection` asks for a database directly. */
export function migrationsTarget(cwd: string, opts: MigrationsTargetOptions): DeployTarget {
  const useDirect = opts.direct === true || Boolean(opts.connection)
  if (loadProjectLink(cwd) && !useDirect) return resolveTarget(cwd, { env: opts.env })
  return resolveTarget(cwd, { env: opts.env, direct: true, connection: opts.connection })
}

/**
 * One migration as `migrations list` prints it: when and how it was applied, who pushed it
 * (verified when a control plane authenticated them, else their own claim), through what and from
 * where, and each rename it applied with who declared it. A migration from before the audit
 * columns names the manifest's `pushedBy`, which was always the client's word.
 */
export function formatMigration(m: MigrationListEntry): string {
  const manifest = m.schemaSourcesManifest
  const size = manifest?.compressedBytes !== undefined ? `${(manifest.compressedBytes / 1024).toFixed(1)} KB` : "-"
  const rolled = m.rolledBack ? " (rolled back)" : ""
  const lines = [
    `${m.name}${rolled}`,
    `  applied: ${m.appliedAt}  status: ${m.status}`,
    `  author: ${migrationAuthor(m)}  via: ${m.pushedVia ?? "-"}  from: ${m.pushedFrom ?? "-"}`,
    `  files: ${manifest?.fileCount ?? "-"}  snapshot: ${size}`,
  ]
  for (const r of m.renames ?? []) {
    lines.push(`  renamed ${renameLabel(r)} (declared by ${r.declared_by ?? "-"}${r.declared_at ? ` at ${r.declared_at}` : ""})`)
  }
  return lines.join("\n")
}

function migrationAuthor(m: MigrationListEntry): string {
  if (m.pushedBy == null) return m.schemaSourcesManifest?.pushedBy ?? "-"
  return m.pushedByVerified === true ? `${m.pushedBy} (verified)` : `${m.pushedBy} (unverified)`
}

export function registerMigrate(program: Command): void {
  const migrations = program
    .command("migrations")
    .description("Migration history utilities")

  migrations
    .command("list")
    .description("List applied migrations with schema snapshot metadata")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--env <name>", "Target environment when linked")
    .option("--direct", "Use local engine subprocess (skip control plane)")
    .action(async (opts: MigrationsTargetOptions) => {
      const list = await targetListMigrations(migrationsTarget(process.cwd(), opts))
      if (list.length === 0) {
        info("No migrations applied.")
        return
      }
      for (const m of list) plain(formatMigration(m))
    })

  program
    .command("migrate")
    .description(
      "Write the SQL a push would apply, without applying it. Plain, it takes no lock your " +
        "application waits on and the file records nothing: applied by hand, the next push finds " +
        "the tables unmanaged. With --record the file also records the migration as a push does",
    )
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option(
      "--record",
      "Rehearse the push so the file records the migration history and which objects are Supatype's. " +
        "Takes the table locks a push takes while it runs",
    )
    .option("--force", "Allow destructive changes, and rewrites of large tables")
    .option("-o, --output <file>", "Write the SQL to this file instead of stdout")
    .action(async (opts: MigrateOptions) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const connection = resolveHostDatabaseUrl(cwd, config, { connection: opts.connection, allowDerived: true }).dsn
      const ast = withPublishing(loadSchemaAst(schemaPathFromProject(config, cwd), cwd), config)

      await ensureEngine()
      const result = await engineRequest(
        "/migrate",
        migrateRequest(ast, connection, schemaPgSchema(cwd), opts),
        isMigrateAnswer,
      )
      const sql = migrationSql(result)
      if (opts.output === undefined) {
        process.stdout.write(`${sql}\n`)
        return
      }
      writeFileSync(opts.output, `${sql}\n`)
      info(`Wrote ${opts.output}${opts.record ? "" : " (it records nothing: see its header)"}.`)
    })

  program
    .command("rollback")
    .description("Roll back the last applied migration")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--env <name>", "Target environment when linked")
    .option("--direct", "Use local engine subprocess (skip control plane)")
    .option("--sync-schema", "Restore schema source files from DB snapshot without prompting")
    .option("--no-sync-schema", "Revert database only; do not restore schema files")
    .action(async (opts: {
      connection?: string
      env?: string
      direct?: boolean
      syncSchema?: boolean
    }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const pgSchema = schemaPgSchema(cwd)
      const link = loadProjectLink(cwd)
      const useDirect = opts.direct || Boolean(opts.connection)

      let target
      if (link && !useDirect && !opts.connection) {
        target = resolveTarget(cwd, { env: opts.env })
      } else {
        target = resolveTarget(cwd, {
          env: opts.env,
          direct: true,
          connection: opts.connection,
        })
      }

      const result = await targetSchemaRollback(target, { schema: pgSchema })
      info(result.message ?? "Rolled back.")

      const restore = schemaRestoreMode(opts)
      if (restore !== "skip") {
        await offerSchemaRestore(cwd, config, target, result, pgSchema, restore === "auto")
      }
    })

  program
    .command("reset")
    .description(
      "Drop all managed tables and re-apply the schema from scratch (destructive)",
    )
    .option("--yes", "Skip confirmation prompt")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { yes?: boolean; connection?: string }) => {
      if (!opts.yes) {
        const confirmed = await confirm(
          "This will DROP all managed tables and re-apply the schema. Proceed?",
          { default: false },
        )
        if (!confirmed) {
          plain("Aborted.")
          return
        }
      }

      const config = loadConfig()
      const connection = resolveHostDatabaseUrl(process.cwd(), config, { connection: opts.connection, allowDerived: true }).dsn
      const cwd = process.cwd()

      await ensureEngine()
      const ast = withPublishing(loadSchemaAst(schemaPathFromProject(config, cwd), cwd), config)
      const result = await engineRequest(
        "/push",
        { ast, database_url: connection, schema: "public", force: true },
        isEnginePushResult,
      )
      info(result.message ?? "Reset complete.")
      printPushWarnings(result)
    })
}

async function offerSchemaRestore(
  cwd: string,
  config: ReturnType<typeof loadConfig>,
  target: ReturnType<typeof resolveTarget>,
  result: SchemaRollbackResult,
  pgSchema: string,
  autoSync: boolean,
): Promise<void> {
  const manifest = result.schemaSourcesManifest
  const gzB64 = result.schemaSourcesBase64

  if (!gzB64 || !isSchemaSourcesManifest(manifest)) {
    warn(
      "No schema source snapshot on the restored migration (legacy push). Run `supatype pull` to draft from DB if needed.",
    )
    return
  }

  const ast = withPublishing(loadSchemaAst(schemaPathFromProject(config, cwd), cwd), config)
  const diff = await targetSchemaDiff(target, ast, { schema: pgSchema })
  const drift = plannedChanges(diff).length > 0

  if (!drift && !autoSync) {
    info("Schema files match reverted database (no restore needed).")
    return
  }

  const fileList = manifest.files.map((f) => f.path).join(", ")
  const sizeKb = (manifest.compressedBytes / 1024).toFixed(1)
  const label = result.restoredMigrationName ?? result.name

  let proceed = autoSync
  if (!proceed) {
    proceed = await confirm(
      `Restore ${manifest.fileCount} schema files from database snapshot (${sizeKb} KB)?\n  ${fileList}`,
      { default: true },
    )
  }

  if (!proceed) {
    info("Skipped schema file restore. Run `supatype diff` to review drift.")
    return
  }

  const root = projectRootFromConfig(config, cwd)
  const backupDir = join(cwd, ".supatype", "schema-backups", `${Date.now()}`)
  const gz = Buffer.from(gzB64, "base64")
  restoreSchemaSourcesFromGz(gz, root, { backupDir })

  const manifestPaths = new Set(manifest.files.map((f) => f.path))
  const orphans = findOrphanSchemaFiles(root, manifest.entryPoint, manifestPaths)
  for (const orphan of orphans) {
    warn(`${orphan} not in snapshot, review manually`)
  }

  info(`Restored schema files from migration ${label}.`)
  info(`Backup saved to ${backupDir}`)

  const postDiff = await targetSchemaDiff(target, ast, { schema: pgSchema })
  if (plannedChanges(postDiff).length === 0) {
    info("Schema matches database after restore.")
  } else {
    info("Run `supatype diff`: schema may still differ from database.")
  }
}
