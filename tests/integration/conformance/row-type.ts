/**
 * The columns of a table's `Row` type in a generated `database.ts`, read with TypeScript's parser.
 *
 * The verifier used to find the `Row` block by searching for the first `}` after `Row: {`. A
 * `JSON<T>` column is emitted with `T` written out, `probeJson: { a: number } | null`, so that
 * search stopped inside the column's own type: the column read as `{ a: number`, with no `| null`,
 * and every column after it was reported missing. Parsing the file has no such failure, and says
 * whether a column is nullable from the type itself rather than from text that could appear
 * anywhere inside it (`{ a: number | null }` is a non-null column).
 */
import ts from "typescript"

export interface RowColumn {
  /** The column's type as written in the file. */
  type: string
  /** True when `null` is one of the type's own union members. */
  nullable: boolean
}

/**
 * Every column of `Database["public"]["Tables"][table]["Row"]`, by name, or `undefined` when the
 * file does not declare that table's `Row`.
 */
export function rowColumns(source: string, table: string): Map<string, RowColumn> | undefined {
  const file = ts.createSourceFile("database.ts", source, ts.ScriptTarget.Latest, true)
  const database = file.statements.find(
    (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === "Database",
  )
  const row = ["public", "Tables", table, "Row"].reduce<ts.TypeNode | undefined>(
    (node, key) => (node === undefined ? undefined : member(node, key)),
    database?.type,
  )
  if (row === undefined || !ts.isTypeLiteralNode(row)) return undefined

  const columns = new Map<string, RowColumn>()
  for (const m of row.members) {
    const name = propertyName(m)
    if (name === undefined || !ts.isPropertySignature(m) || m.type === undefined) continue
    columns.set(name, { type: m.type.getText(file), nullable: admitsNull(m.type) })
  }
  return columns
}

/** The type of property `key` of an object type literal. */
function member(node: ts.TypeNode, key: string): ts.TypeNode | undefined {
  if (!ts.isTypeLiteralNode(node)) return undefined
  const found = node.members.find((m) => propertyName(m) === key)
  return found !== undefined && ts.isPropertySignature(found) ? found.type : undefined
}

/** A member's name, whether written bare (`probe_all`) or quoted (`"probe-all"`). */
function propertyName(m: ts.TypeElement): string | undefined {
  const name = m.name
  if (name === undefined) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return undefined
}

/** True when `null` is a member of the type's top-level union, which is what makes a column nullable. */
function admitsNull(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type)) return admitsNull(type.type)
  if (ts.isLiteralTypeNode(type)) return type.literal.kind === ts.SyntaxKind.NullKeyword
  return ts.isUnionTypeNode(type) && type.types.some(admitsNull)
}
