import type { Command } from "commander"
import { createInterface } from "node:readline"
import { loadConfig, loadSchemaAst } from "../config.js"
import { invokeEngine } from "../engine.js"

interface DiffResult {
  operations: Operation[]
}

interface Operation {
  kind: string
  risk: "safe" | "cautious" | "destructive"
  description: string
}

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
      const connection = opts.connection ?? config.connection

      console.log("Loading schema...")
      const ast = loadSchemaAst(config.schema, cwd)

      console.log("Diffing against database...")
      const diffResult = invokeEngine(
        ["diff", "--connection", connection, "--format", "json"],
        JSON.stringify(ast),
      )
      if (diffResult.exitCode !== 0) {
        console.error(diffResult.stderr || diffResult.stdout)
        process.exit(1)
      }

      const diff = JSON.parse(diffResult.stdout) as DiffResult
      const ops = diff.operations ?? []

      if (ops.length === 0) {
        console.log("Schema is up to date. Nothing to push.")
        return
      }

      printDiff(ops)

      const destructive = ops.filter((o) => o.risk === "destructive")
      if (destructive.length > 0 && !opts.yes) {
        const confirmed = await confirm(
          `\n${destructive.length} destructive operation(s) above. Proceed? [y/N] `,
        )
        if (!confirmed) {
          console.log("Aborted.")
          return
        }
      }

      console.log("\nApplying migration...")
      const migrateResult = invokeEngine(
        ["migrate", "--connection", connection],
        JSON.stringify(ast),
      )
      if (migrateResult.exitCode !== 0) {
        console.error(migrateResult.stderr || migrateResult.stdout)
        process.exit(1)
      }
      console.log(migrateResult.stdout || "Migration applied.")

      if (config.output?.types ?? config.output?.client) {
        console.log("Generating types...")
        const genArgs = ["generate", "--connection", connection]
        if (config.output?.types) genArgs.push("--types", config.output.types)
        if (config.output?.client) genArgs.push("--client", config.output.client)

        const genResult = invokeEngine(genArgs, JSON.stringify(ast))
        if (genResult.exitCode !== 0) {
          console.error(genResult.stderr || genResult.stdout)
          process.exit(1)
        }
        console.log(genResult.stdout || "Types generated.")
      }

      console.log("\nDone.")
    })
}

function printDiff(ops: Operation[]): void {
  const symbol: Record<Operation["risk"], string> = {
    safe: "+",
    cautious: "~",
    destructive: "!",
  }
  console.log(`\n${ops.length} change(s) planned:\n`)
  for (const op of ops) {
    console.log(`  [${symbol[op.risk]}] ${op.description}`)
  }
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
