import type { Command } from "commander"
import { mkdirSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { loadConfig, loadSchemaAst } from "../config.js"
import { connectionString, resolveRuntimeProvider, schemaPathFromProject, serverBaseUrl } from "../project-config.js"
import { isCloudLinked, pushSchemaToLinkedProject } from "./cloud.js"
import { ensureEngine, engineRequest, type DiffResult } from "../engine-client.js"
import { printDiffOperations, printDiffWarnings } from "../diff-output.js"
import { signJwt } from "../jwt.js"
import { provisionBucketsFromAst } from "../storage-provision.js"
import type { ExtractedSchemaAstV2 } from "../schema-ast-v2.js"
import { promptFirstAdminUser } from "./admin.js"
import { withAdminRoles } from "../studio-admin-roles.js"
import { restoreSystemRelationTargets } from "../restore-system-relation-targets.js"
import type { SupatypeProjectConfig } from "../project-config.js"

const DEV_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long"

export function registerPush(program: Command): void {
  program
    .command("push")
    .description(
      "Push schema to the database: diff, prompt for destructive changes, apply migration, generate types",
    )
    .option("--yes", "Skip confirmation prompts for destructive changes")
    .option("--connection <url>", "Database connection URL (overrides config)")
    .action(async (opts: { yes?: boolean; connection?: string }) => {
      const cwd = process.cwd()

      if (isCloudLinked(cwd)) {
        if (opts.connection) {
          console.error("--connection is not allowed when linked to a cloud project (credentials stay server-side).")
          process.exit(1)
        }
        await pushSchemaToLinkedProject(cwd, { force: opts.yes ?? true })
        return
      }

      const config = loadConfig(cwd)

      // Docker provider: the compose Postgres isn't published to the host, so
      // apply the schema through the in-compose schema-engine (unless the user
      // gave an explicit --connection to a reachable database).
      if (!opts.connection && resolveRuntimeProvider(config) === "docker") {
        const { pushSchemaDocker } = await import("../dev-compose.js")
        await pushSchemaDocker(cwd, config)
        return
      }

      const connection = opts.connection ?? connectionString(config)

      await ensureEngine()

      console.log("Loading schema...")
      const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)

      console.log("Diffing against database...")
      const diff = await engineRequest<DiffResult>("/diff", {
        ast,
        database_url: connection,
        schema: "public",
      })

      const ops = diff.operations ?? []
      printDiffWarnings(diff)

      if (ops.length === 0) {
        console.log(
          "Schema matches the database (no DDL). Syncing Studio metadata...",
        )
      } else {
        printDiffOperations({ operations: ops })

        const risky = ops.filter(
          (o) => o.risk === "cautious" || o.risk === "destructive" || o.risk === "warn" || o.risk === "danger",
        )
        if (risky.length > 0 && !opts.yes) {
          const confirmed = await confirm(
            `\n${risky.length} risky operation(s) above (type changes or data loss). Proceed? [y/N] `,
          )
          if (!confirmed) {
            console.log("Aborted.")
            return
          }
        }
      }

      console.log(ops.length > 0 ? "\nApplying migration..." : "\nSyncing with engine...")
      const pushResult = await engineRequest<{
        message?: string
        status?: string
        admin_refreshed?: boolean
      }>("/push", {
        ast,
        database_url: connection,
        schema: "public",
        force: true,
      })
      if (pushResult.status === "up_to_date") {
        console.log(
          pushResult.admin_refreshed
            ? "Database schema unchanged — Studio metadata synced."
            : "Schema is up to date.",
        )
      } else {
        console.log(pushResult.message ?? "Migration applied.")
      }

      await writeLocalAdminConfig(ast, config)

      // After a DDL migration, check if this is the first push and offer to create an
      // admin user if none exist (Gap Appendices task 48).
      if (ops.length > 0) {
        await promptFirstAdminUser(connection)
      }

      // Provision storage buckets declared in the schema.
      const baseUrl = serverBaseUrl(config)
      const serviceRoleKey =
        process.env["SUPATYPE_SERVICE_ROLE_KEY"] ??
        (config.server.mode === "dev"
          ? signJwt({ role: "service_role", iss: "supatype", iat: Math.floor(Date.now() / 1000) }, DEV_JWT_SECRET)
          : undefined)

      if (baseUrl && serviceRoleKey) {
        const parsedAst = await engineRequest<Pick<ExtractedSchemaAstV2, "storageBuckets">>(
          "/parse",
          { ast },
        )
        await provisionBucketsFromAst(parsedAst, `${baseUrl}/storage/v1`, serviceRoleKey)
      }

      if (config.output?.types ?? config.output?.client) {
        console.log("Generating types...")
        const genBody: Record<string, unknown> = { ast, lang: "typescript" }
        if (config.output?.types) genBody["types_path"] = config.output.types
        if (config.output?.client) genBody["client_path"] = config.output.client

        const genResult = await engineRequest<{ code?: string; message?: string }>("/generate", genBody)
        console.log(genResult.message ?? "Types generated.")
      }

      const studioBase = baseUrl?.replace(/\/$/, "") ?? ""
      if (studioBase) {
        console.log(`\nStudio: ${studioBase}/studio/ — sign in with the admin user you created.`)
      } else {
        console.log("\nDone.")
      }
    })
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === "y")
    })
  })
}

/** Write `.supatype/admin-config.json` for local Studio (same layout as `supatype dev`). */
async function writeLocalAdminConfig(ast: unknown, config: SupatypeProjectConfig): Promise<void> {
  const cwd = process.cwd()
  const dir = join(cwd, ".supatype")
  mkdirSync(dir, { recursive: true })
  const admin = withAdminRoles(await engineRequest<unknown>("/admin", { ast }), config)
  restoreSystemRelationTargets(admin, ast)
  writeFileSync(join(dir, "admin-config.json"), `${JSON.stringify(admin, null, 2)}\n`)
}
