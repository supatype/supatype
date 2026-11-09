/**
 * `supatype reset`: drop every table the schema manages, apply the schema again, then run the seeds.
 *
 * It used to push the current schema with `force`, which against a database already at that schema
 * changes nothing, and then said "Reset complete." (issue 72). Now it pushes a schema with no
 * models first, which drops every table the project's ledger says is its own, then the real one.
 *
 * Only the app's tables go, as Prisma's `migrate reset` drops only its own schema. Sign-ins, Studio
 * users and stored files live outside them and stay. `supatype dev --reset-db` is the one that
 * starts the whole database again.
 */

import { existsSync } from "node:fs"
import type { SupatypeConfig } from "./config.js"
import { withDatabase } from "./db-rows.js"
import { enginePush, ensureEngine, type ComposeEngine } from "./engine-client.js"
import { isEnginePushResult } from "./engine-answers.js"
import { printPushWarnings, type EnginePushResult } from "./engine-push-output.js"
import { errorMessage } from "./error-message.js"
import type { ExtractedSchemaAstV2 } from "./schema-ast-v2.js"
import { runSeed, seedPaths } from "./commands/seed.js"
import { info, plain } from "./ui/messages.js"

/** The question `reset` asks before it starts, which says what goes and what stays. */
export function resetQuestion(seed: boolean): string {
  const then = seed ? "applies the schema again and runs the seeds" : "applies the schema again"
  return (
    `This drops every table your schema manages, with all its rows, then ${then}.\n` +
    "  Sign-ins, Studio users and stored files are kept. Proceed?"
  )
}

/**
 * `ast` with no models: what a push takes to drop every table the project manages. The buckets
 * and locales stay, so the push leaves storage as it is. The rename journal and the publishing
 * settings go with the models they are about.
 */
export function withoutModels(ast: ExtractedSchemaAstV2): ExtractedSchemaAstV2 {
  return {
    astVersion: ast.astVersion,
    models: [],
    ...(ast.storageBuckets !== undefined && { storageBuckets: ast.storageBuckets }),
    ...(ast.locales !== undefined && { locales: ast.locales }),
    ...(ast.defaultLocale !== undefined && { defaultLocale: ast.defaultLocale }),
  }
}

/** Where `reset` runs, as the command resolved it. */
export interface ResetTarget {
  cwd: string
  config: SupatypeConfig
  /** The database as the host reaches it. */
  dsn: string
  /** The compose engine, or undefined for the host binary ({@link stackEngine}). */
  engine: ComposeEngine | undefined
  /** `--connection`, handed on to the seed run. */
  connection: string | undefined
}

/** How many operations a push ran, as a phrase. */
function operationCount(result: EnginePushResult): string {
  const count = result.operations ?? 0
  return `${count} operation${count === 1 ? "" : "s"}`
}

/** Push `ast` with consent to lose data, through `enginePush`, so the push log says who reset. */
async function forcePush(target: ResetTarget, ast: ExtractedSchemaAstV2): Promise<EnginePushResult> {
  if (target.engine === undefined) await ensureEngine()
  return enginePush(target.cwd, { ast, database_url: target.dsn, schema: "public", force: true }, isEnginePushResult, target.engine)
}

/**
 * Drop the managed tables, apply `ast` again, and forget the seed runs, whose rows are gone. Throws,
 * saying how far it got, on a failure.
 */
export async function resetSchema(target: ResetTarget, ast: ExtractedSchemaAstV2): Promise<void> {
  const dropped = await forcePush(target, withoutModels(ast))
  info(`Dropped the managed tables (${operationCount(dropped)}).`)
  let applied: EnginePushResult
  try {
    applied = await forcePush(target, ast)
  } catch (e) {
    throw new Error(
      `The managed tables were dropped, but applying the schema again failed:\n  ${errorMessage(e)}\n` +
        "  Fix the cause, then run `supatype push` to create them.",
      { cause: e },
    )
  }
  info(`Applied the schema (${operationCount(applied)}).`)
  printPushWarnings(applied)
  try {
    await clearSeedLedger(target.dsn)
  } catch (e) {
    throw new Error(`The schema was reset, but clearing the seed record failed: ${errorMessage(e)}`, { cause: e })
  }
}

/**
 * Forget every seed run, so a `runOnce` seed runs again on the empty tables. No table yet means
 * nothing has been seeded. The `WHERE` is for the image's `pg_safeupdate`, which refuses a `DELETE`
 * without one.
 */
async function clearSeedLedger(dsn: string): Promise<void> {
  await withDatabase(dsn, async (client) => {
    await client.query(
      "DO $$ BEGIN IF to_regclass('_supatype.seeds') IS NOT NULL THEN DELETE FROM _supatype.seeds WHERE true; END IF; END $$",
    )
  })
}

/** Run the project's seeds as `supatype seed` would. The exit code. */
export async function reseed(target: ResetTarget): Promise<number> {
  if (!seedPaths(undefined, target.cwd, target.config).some((path) => existsSync(path))) {
    plain("No seeds to run.")
    return 0
  }
  return runSeed(undefined, {
    force: false,
    atomic: false,
    status: false,
    ...(target.connection !== undefined && { connection: target.connection }),
  })
}
