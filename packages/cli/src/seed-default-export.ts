/**
 * Whether a seed file has a default export, answered from its text.
 *
 * A seed with no default export does its writes when it is imported, against whatever its own code
 * connects to. Sent to a control plane that has to be known before the file is imported, so this
 * reads the file and never runs it. Anything that cannot be read as TypeScript is `unknown`, and the
 * caller refuses it: a wrong "present" would import the file.
 */

import { readFileSync } from "node:fs"
import ts from "typescript"

export type DefaultExport = "present" | "absent" | "unknown"

/** The default export of the seed file at `path`. */
export function defaultExportOf(path: string): DefaultExport {
  let source: string
  try {
    source = readFileSync(path, "utf8")
  } catch {
    return "unknown"
  }
  // `transpileModule` reports syntax errors only, which is all that makes the file unreadable here.
  const { diagnostics } = ts.transpileModule(source, { reportDiagnostics: true, fileName: path })
  if (diagnostics === undefined || diagnostics.length > 0) return "unknown"
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false)
  return file.statements.some(exportsDefault) ? "present" : "absent"
}

function exportsDefault(statement: ts.Statement): boolean {
  if (ts.isExportAssignment(statement)) return statement.isExportEquals !== true
  if (ts.isExportDeclaration(statement)) return namesDefault(statement)
  return hasModifier(statement, ts.SyntaxKind.ExportKeyword) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
}

/** `export { x as default }` and `export { default } from "./x"`. `export *` never carries a default. */
function namesDefault(statement: ts.ExportDeclaration): boolean {
  const clause = statement.exportClause
  if (clause === undefined || !ts.isNamedExports(clause)) return false
  return clause.elements.some((element) => element.name.text === "default")
}

function hasModifier(statement: ts.Statement, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((m) => m.kind === kind)
}
