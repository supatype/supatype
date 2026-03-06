import type { Command } from "commander"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { loadConfig } from "../config.js"
import { invokeEngine } from "../engine.js"
import { pgTypeToField, toCamelCase, type ColumnInfo } from "../pull-utils.js"

interface IntrospectResult {
  models: Array<{
    name: string
    tableName: string
    columns: ColumnInfo[]
  }>
}

export function registerPull(program: Command): void {
  program
    .command("pull")
    .description(
      "Introspect an existing Postgres database and generate TypeScript schema files",
    )
    .option("--connection <url>", "Database connection URL (overrides config)")
    .option("--output <path>", "Output directory for schema files", "./schema")
    .action((opts: { connection?: string; output: string }) => {
      const cwd = process.cwd()
      const connection = opts.connection ?? loadConfig(cwd).connection

      console.log("Introspecting database...")
      const result = invokeEngine([
        "introspect",
        "--connection",
        connection,
        "--format",
        "json",
      ])
      if (result.exitCode !== 0) {
        console.error(result.stderr || result.stdout)
        process.exit(1)
      }

      const introspected = JSON.parse(result.stdout) as IntrospectResult
      const models = introspected.models ?? []

      if (models.length === 0) {
        console.log("No tables found in the database.")
        return
      }

      const outputDir = resolve(cwd, opts.output)
      mkdirSync(outputDir, { recursive: true })

      for (const model of models) {
        const content = generateModelFile(model)
        writeFileSync(resolve(outputDir, `${model.name}.ts`), content, "utf8")
        console.log(`  wrote  ${opts.output}/${model.name}.ts`)
      }

      const indexContent = generateIndexFile(models.map((m) => m.name))
      writeFileSync(resolve(outputDir, "index.ts"), indexContent, "utf8")
      console.log(`  wrote  ${opts.output}/index.ts`)

      console.log(
        `\nPulled ${models.length} model(s). Review TODO comments before running supatype push.\n`,
      )
    })
}

function generateModelFile(model: IntrospectResult["models"][number]): string {
  const fieldLines = model.columns
    .map((col) => `    ${col.name}: ${pgTypeToField(col)},`)
    .join("\n")

  return `import { model, field, access } from "@supatype/schema"

// TODO: review access rules — all operations default to authenticated
export const ${toCamelCase(model.name)} = model(${JSON.stringify(model.name)}, {
  tableName: ${JSON.stringify(model.tableName)},
  fields: {
${fieldLines}
  },
  access: {
    read: access.role("authenticated"),
    create: access.role("authenticated"),
    update: access.role("authenticated"),
    delete: access.role("authenticated"),
  },
})
`
}

function generateIndexFile(names: string[]): string {
  return names
    .map((n) => `export { ${toCamelCase(n)} } from "./${n}.js"`)
    .join("\n") + "\n"
}
