/**
 * The columns of a table's `Row` type in a generated file, read with TypeScript's parser.
 *
 * Two files describe the same rows, written by two generators: the engine's `database.ts`
 * (`Database["public"]["Tables"][table]["Row"]`) and the CLI's client augmentation, `index.d.ts`
 * (`SupatypeModels[table]["Row"]` inside `declare module "@supatype/client"`). Both are read here,
 * so a column the two generators type differently is caught by the same assertion.
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

type Members = ts.NodeArray<ts.TypeElement>

/**
 * Every column of `table`'s `Row`, by name, from either generated file, or `undefined` when the
 * file does not declare that table's `Row`.
 */
export function rowColumns(source: string, table: string): Map<string, RowColumn> | undefined {
  const file = ts.createSourceFile("generated.ts", source, ts.ScriptTarget.Latest, true)
  const row = databaseRow(file, table) ?? augmentationRow(file, table)
  if (row === undefined) return undefined

  const columns = new Map<string, RowColumn>()
  for (const m of row) {
    const name = propertyName(m)
    if (name === undefined || !ts.isPropertySignature(m) || m.type === undefined) continue
    columns.set(name, { type: m.type.getText(file), nullable: admitsNull(m.type) })
  }
  return columns
}

/** `Database["public"]["Tables"][table]["Row"]`, as the engine's `database.ts` declares it. */
function databaseRow(file: ts.SourceFile, table: string): Members | undefined {
  const database = file.statements.find(
    (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === "Database",
  )
  if (database === undefined || !ts.isTypeLiteralNode(database.type)) return undefined
  return path(database.type.members, ["public", "Tables", table, "Row"])
}

/** `SupatypeModels[table]["Row"]`, as the client augmentation declares it. */
function augmentationRow(file: ts.SourceFile, table: string): Members | undefined {
  for (const statement of file.statements) {
    if (!ts.isModuleDeclaration(statement) || statement.body === undefined) continue
    if (!ts.isModuleBlock(statement.body)) continue
    const models = statement.body.statements.find(
      (s): s is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(s) && s.name.text === "SupatypeModels",
    )
    if (models !== undefined) return path(models.members, [table, "Row"])
  }
  return undefined
}

/** The members of the object type reached by following `keys` from `members`. */
function path(members: Members, keys: readonly string[]): Members | undefined {
  let current: Members | undefined = members
  for (const key of keys) {
    const found: ts.TypeElement | undefined = current?.find((m) => propertyName(m) === key)
    const type: ts.TypeNode | undefined =
      found !== undefined && ts.isPropertySignature(found) ? found.type : undefined
    current = type !== undefined && ts.isTypeLiteralNode(type) ? type.members : undefined
  }
  return current
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
