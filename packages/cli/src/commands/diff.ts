import { withPublishing } from "../model-versioning.js"
import type { Command } from "commander"
import { requireLocalStack } from "../local-stack-guard.js"
import { loadConfig, loadSchemaAst } from "../config.js"
import { resolveRuntimeProvider, schemaPathFromProject, type SupatypeProjectConfig } from "../project-config.js"
import { printDiffOperations, printDiffWarnings } from "../diff-output.js"
import { printRoleAccess } from "../diff-access.js"
import type { DiffResult } from "../engine-client.js"
import { resolveTarget, targetSchemaDiff, schemaPgSchema, type DeployTarget } from "../resolve-target.js"
import { loadProjectLink } from "../link.js"
import { withSpinner } from "../ui/progress.js"

interface DiffOptions {
  connection?: string
  env?: string
  direct?: boolean
}

export function registerDiff(program: Command): void {
  program
    .command("diff")
    .description("Show planned schema changes without applying them (dry run)")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--env <name>", "Target environment when linked")
    .option("--direct", "Use local engine subprocess")
    .action(async (opts: DiffOptions) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      requireLocalStack(cwd, config, "diff", opts)
      const ast = await withSpinner("Loading schema", async () =>
        withPublishing(loadSchemaAst(schemaPathFromProject(config, cwd), cwd), config),
      )
      printDiff(await computeDiff(cwd, config, ast, opts))
    })
}

/** Everything `diff` says about a plan: the engine's warnings, the changes, and each role's access. */
export function printDiff(diff: DiffResult): void {
  printDiffWarnings(diff)
  printDiffOperations(diff)
  printRoleAccess(diff)
}

/**
 * The plan from wherever this project's database is reached: the linked target, the local stack's
 * server or Docker Compose, or a direct connection.
 */
async function computeDiff(cwd: string, config: SupatypeProjectConfig, ast: unknown, opts: DiffOptions): Promise<DiffResult> {
  const onTarget = (target: DeployTarget) =>
    withSpinner("Computing diff", () => targetSchemaDiff(target, ast, { schema: schemaPgSchema(cwd) }))
  const useDirect = opts.direct === true || Boolean(opts.connection)

  if (loadProjectLink(cwd) && !useDirect) return onTarget(resolveTarget(cwd, { env: opts.env }))

  if (!useDirect && resolveRuntimeProvider(config) === "docker") {
    const localTarget = resolveTarget(cwd, { env: opts.env })
    if (localTarget.mode === "local" && localTarget.token) return onTarget(localTarget)
    const { diffSchemaDocker } = await import("../dev-compose.js")
    return withSpinner("Computing diff via Docker Compose", () => diffSchemaDocker(cwd, config))
  }

  return onTarget(resolveTarget(cwd, { env: opts.env, direct: true, connection: opts.connection }))
}
