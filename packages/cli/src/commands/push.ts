import type { Command } from "commander"
import { mkdirSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { loadConfig, loadSchemaAst } from "../config.js"
import { connectionString, schemaPathFromProject, serverBaseUrl } from "../project-config.js"
import { ensureEngine, engineRequest, type DiffResult, type Operation } from "../engine-client.js"
import { signJwt } from "../jwt.js"
import { provisionBuckets } from "../storage-provision.js"
import { promptFirstAdminUser } from "./admin.js"

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
      const config = loadConfig(cwd)
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

      if (ops.length === 0) {
        console.log(
          "Schema matches the database (no DDL). Refreshing admin metadata and local Studio config...",
        )
      } else {
        printDiff(ops)

        const destructive = ops.filter((o) => o.risk === "danger")
        if (destructive.length > 0 && !opts.yes) {
          const confirmed = await confirm(
            `\n${destructive.length} destructive operation(s) above. Proceed? [y/N] `,
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
            ? "Admin config updated on the latest migration record (no SQL applied)."
            : "Schema is up to date.",
        )
      } else {
        console.log(pushResult.message ?? "Migration applied.")
      }

      await writeLocalAdminConfig(ast)

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
        const parsedAst = await engineRequest<{
          storageBuckets?: Array<{
            id: string
            public: boolean
            accessMode?: "public" | "private" | "custom"
            allowedMimeTypes?: string[]
            fileSizeLimit?: number
            s3BucketPolicy?: string
          }>
        }>("/parse", { ast })
        const buckets = (parsedAst.storageBuckets ?? []).map((b) => ({
          id: b.id,
          public: b.public,
          ...(b.accessMode !== undefined && { access_mode: b.accessMode }),
          ...(b.allowedMimeTypes != null && { allowed_mime_types: b.allowedMimeTypes }),
          ...(b.fileSizeLimit != null && { file_size_limit: b.fileSizeLimit }),
          ...(b.s3BucketPolicy != null &&
            b.s3BucketPolicy !== "" && { s3_bucket_policy: b.s3BucketPolicy }),
        }))
        if (buckets.length > 0) {
          console.log("Provisioning storage buckets...")
          await provisionBuckets(`${baseUrl}/storage/v1`, serviceRoleKey, buckets)
        }
      }

      if (config.output?.types ?? config.output?.client) {
        console.log("Generating types...")
        const genBody: Record<string, unknown> = { ast, lang: "typescript" }
        if (config.output?.types) genBody["types_path"] = config.output.types
        if (config.output?.client) genBody["client_path"] = config.output.client

        const genResult = await engineRequest<{ code?: string; message?: string }>("/generate", genBody)
        console.log(genResult.message ?? "Types generated.")
      }

      console.log("\nDone.")
    })
}

function printDiff(ops: Operation[]): void {
  const symbol: Record<NonNullable<Operation["risk"]>, string> = {
    safe: "+",
    warn: "~",
    danger: "!",
  }
  console.log(`\n${ops.length} change(s) planned:\n`)
  for (const op of ops) {
    const s = op.risk ? symbol[op.risk] : "?"
    console.log(`  [${s}] ${formatOperation(op)}`)
  }
}

function formatOperation(op: Operation): string {
  if (typeof op.description === "string" && op.description.trim().length > 0) {
    return op.description
  }

  const kind = typeof op.kind === "string" ? op.kind : "operation"
  const raw = op as unknown as Record<string, unknown>
  const table = raw["table"]
  const column = raw["column"]

  if (typeof table === "string" && typeof column === "string") {
    return `${kind} ${table}.${column}`
  }
  if (typeof table === "string") {
    return `${kind} ${table}`
  }

  // Last resort: show operation kind with compact payload.
  return `${kind} ${JSON.stringify(op)}`
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
async function writeLocalAdminConfig(ast: unknown): Promise<void> {
  const cwd = process.cwd()
  const dir = join(cwd, ".supatype")
  mkdirSync(dir, { recursive: true })
  const admin = await engineRequest<unknown>("/admin", { ast })
  writeFileSync(join(dir, "admin-config.json"), `${JSON.stringify(admin, null, 2)}\n`)
}
