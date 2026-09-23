import type { Command } from "commander"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"
import ts from "typescript"
import { loadConfig } from "../config.js"
import { schemaPathFromProject } from "../project-config.js"
import { info } from "../ui/messages.js"

export function registerMigrateFromV1(program: Command): void {
  program
    .command("migrate-from-v1")
    .description("Codemod runtime model() schema DSL into RFC v2 Model<> type aliases")
    .option("--schema <path>", "Path to v1 schema file (defaults to supatype.config.ts schema)")
    .option("--write", "Overwrite source file instead of creating .v2.ts sibling")
    .action((opts: { schema?: string; write?: boolean }) => {
      const cwd = process.cwd()
      const cfg = loadConfig(cwd)
      const schemaPath = opts.schema !== undefined
        ? resolve(cwd, opts.schema)
        : schemaPathFromProject(cfg, cwd)
      if (!existsSync(schemaPath)) {
        throw new Error(`Schema file not found: ${schemaPath}`)
      }

      const src = readFileSync(schemaPath, "utf8")
      const sf = ts.createSourceFile(schemaPath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const output = codemodSource(sf)
      const outPath = opts.write
        ? schemaPath
        : join(dirname(schemaPath), basename(schemaPath).replace(extname(schemaPath), ".v2.ts"))

      writeFileSync(outPath, output, "utf8")
      info(`v2 schema written to ${outPath}`)
      if (!opts.write) {
        info("Review TODO comments and replace unknown mappings before using this file in production.")
      }
    })
}

export function codemodSource(sf: ts.SourceFile): string {
  const lines: string[] = []
  lines.push('import type { Model, UUID, Optional } from "@supatype/types"')
  lines.push("")
  lines.push("// TODO(v2-migration): verify each mapped type and access rule below.")
  lines.push("")

  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    if (!(ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)) continue

    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      const modelCall = extractModelCall(decl.initializer)
      if (!modelCall) continue
      const fields = extractFields(modelCall.config)
      const modelType = renderModelType(decl.name.text, fields)
      lines.push(modelType)
      lines.push("")
    }
  }

  if (lines.length <= 4) {
    lines.push("// TODO(v2-migration): no model() declarations were detected in this file.")
  }

  return lines.join("\n")
}

function extractModelCall(node: ts.Expression): { config: ts.ObjectLiteralExpression } | null {
  if (!ts.isCallExpression(node)) return null
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "model") return null
  const config = node.arguments[1]
  if (!config || !ts.isObjectLiteralExpression(config)) return null
  return { config }
}

function extractFields(config: ts.ObjectLiteralExpression): Array<{ name: string; type: string }> {
  const fieldsProp = config.properties.find(
    (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "fields",
  )
  if (!fieldsProp || !ts.isPropertyAssignment(fieldsProp) || !ts.isObjectLiteralExpression(fieldsProp.initializer)) {
    return []
  }

  const result: Array<{ name: string; type: string }> = []
  for (const prop of fieldsProp.initializer.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    result.push({
      name: prop.name.text,
      type: mapFieldInitializerToType(prop.initializer),
    })
  }
  return result
}

function mapFieldInitializerToType(node: ts.Expression): string {
  if (!ts.isCallExpression(node)) return "unknown // TODO(v2-migration): unsupported field expression"
  if (!ts.isPropertyAccessExpression(node.expression)) return "unknown // TODO(v2-migration): unsupported field expression"
  if (!ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "field") {
    return "unknown // TODO(v2-migration): unsupported field expression"
  }

  const kind = node.expression.name.text
  switch (kind) {
    case "uuid":
      return "UUID"
    case "text":
    case "slug":
    case "email":
    case "url":
      return "string"
    case "integer":
    case "smallInt":
    case "float":
    case "decimal":
      return "number"
    case "boolean":
      return "boolean"
    case "richText":
    case "json":
      return "Record<string, unknown>"
    default:
      return "unknown // TODO(v2-migration): map field." + kind
  }
}

function renderModelType(name: string, fields: Array<{ name: string; type: string }>): string {
  const fieldsBlock = fields
    .map((field) => `  ${field.name}: ${field.type}`)
    .join("\n")
  return `export type ${name} = Model<{\n${fieldsBlock}\n}>`
}
