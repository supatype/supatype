import type { Command } from "commander"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { loadConfig, loadSchemaAst } from "../config.js"
import { connectionString, projectRootFromConfig, schemaPathFromProject } from "../project-config.js"
import { ensureEngine, engineRequest } from "../engine-client.js"
import { loadProjectLink } from "../link.js"
import {
  resolveTarget,
  targetSchemaDiff,
  targetSchemaRollback,
  targetListMigrations,
  schemaPgSchema,
  type SchemaRollbackResult,
} from "../resolve-target.js"
import {
  restoreSchemaSourcesFromGz,
  findOrphanSchemaFiles,
  type SchemaSourcesManifest,
} from "../schema-sources.js"

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
    .action(async (opts: { connection?: string; env?: string; direct?: boolean }) => {
      const cwd = process.cwd()
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

      const list = await targetListMigrations(target)
      if (list.length === 0) {
        console.log("No migrations applied.")
        return
      }

      for (const m of list) {
        const manifest = m.schemaSourcesManifest
        const size =
          manifest?.compressedBytes !== undefined
            ? `${(manifest.compressedBytes / 1024).toFixed(1)} KB`
            : "—"
        const files = manifest?.fileCount ?? "—"
        const author = manifest?.pushedBy ?? "—"
        const rolled = m.rolledBack ? " (rolled back)" : ""
        console.log(
          `${m.name}${rolled}\n  applied: ${m.appliedAt}  status: ${m.status}\n  author: ${author}  files: ${files}  snapshot: ${size}`,
        )
      }
    })

  program
    .command("migrate")
    .description("Apply pending migrations from the migration history")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { connection?: string }) => {
      const config = loadConfig()
      const connection = opts.connection ?? connectionString(config)

      await ensureEngine()
      const result = await engineRequest<{ message?: string }>("/migrations", {
        database_url: connection,
        schema: "public",
        action: "pending",
      })
      console.log(result.message ?? "Migrations applied.")
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
      noSyncSchema?: boolean
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
      console.log(result.message ?? "Rolled back.")

      if (!opts.noSyncSchema) {
        await offerSchemaRestore(cwd, config, target, result, pgSchema, opts.syncSchema ?? false)
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
          "This will DROP all managed tables and re-apply the schema. Proceed? [y/N] ",
        )
        if (!confirmed) {
          console.log("Aborted.")
          return
        }
      }

      const config = loadConfig()
      const connection = opts.connection ?? connectionString(config)
      const cwd = process.cwd()

      await ensureEngine()
      const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)
      const result = await engineRequest<{ message?: string }>("/push", {
        ast,
        database_url: connection,
        schema: "public",
        force: true,
      })
      console.log(result.message ?? "Reset complete.")
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
  const manifest = result.schemaSourcesManifest as SchemaSourcesManifest | undefined
  const gzB64 = result.schemaSourcesBase64

  if (!gzB64 || !manifest) {
    console.warn(
      "No schema source snapshot on the restored migration (legacy push). Run `supatype pull` to draft from DB if needed.",
    )
    return
  }

  const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)
  const diff = await targetSchemaDiff(target, ast, { schema: pgSchema })
  const drift = (diff.operations ?? []).length > 0

  if (!drift && !autoSync) {
    console.log("Schema files match reverted database (no restore needed).")
    return
  }

  const fileList = manifest.files.map((f) => f.path).join(", ")
  const sizeKb = (manifest.compressedBytes / 1024).toFixed(1)
  const label = result.restoredMigrationName ?? result.name

  let proceed = autoSync
  if (!proceed) {
    proceed = await confirm(
      `\nRolled back migration ${result.name}.\nRestore ${manifest.fileCount} schema files from database snapshot (${sizeKb} KB)?\n  ${fileList}\n  [Y/n] `,
    )
  }

  if (!proceed) {
    console.log("Skipped schema file restore. Run `supatype diff` to review drift.")
    return
  }

  const root = projectRootFromConfig(config, cwd)
  const backupDir = join(cwd, ".supatype", "schema-backups", `${Date.now()}`)
  const gz = Buffer.from(gzB64, "base64")
  restoreSchemaSourcesFromGz(gz, manifest, root, { backupDir })

  const manifestPaths = new Set(manifest.files.map((f) => f.path))
  const orphans = findOrphanSchemaFiles(root, manifest.entryPoint, manifestPaths)
  for (const orphan of orphans) {
    console.warn(`Warning: ${orphan} not in snapshot — review manually`)
  }

  console.log(`Restored schema files from migration ${label}.`)
  console.log(`Backup saved to ${backupDir}`)

  const postDiff = await targetSchemaDiff(target, ast, { schema: pgSchema })
  if ((postDiff.operations ?? []).length === 0) {
    console.log("Schema matches database after restore.")
  } else {
    console.log("Run `supatype diff` — schema may still differ from database.")
  }
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolveConfirm) => {
    rl.question(prompt, (answer) => {
      rl.close()
      const trimmed = answer.trim().toLowerCase()
      resolveConfirm(trimmed === "" || trimmed === "y" || trimmed === "yes")
    })
  })
}
