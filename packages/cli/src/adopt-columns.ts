/**
 * Adopting a column declares it.
 *
 * `supatype adopt column:<table>.<name>` hands Supatype a column someone added outside the schema
 * (engine: it is recorded in the ledger and its narrowed write grant includes it). Adopted means
 * managed, and a managed column is one the schema declares, so the CLI then adds the field to the
 * model whose table it is, and regenerates types: from the next push it is an ordinary field.
 *
 * Rewriting someone's source is only done when it can be done exactly, and only when a person
 * agreed: at a prompt, or up front with `--yes`, which agrees to the adopt and to the edit it implies
 * (an adopted column the schema does not declare is a push that drops it). The field key is the
 * column name (a field's key is its column, verbatim: the engine does not convert case), its type
 * is one whose column is exactly the live one, so the next push changes nothing, and the edit is
 * checked by reading the schema back. Otherwise, or when the person declines or cannot be asked
 * without `--yes`, the file is untouched and the CLI prints the line to add and where. A file the
 * CLI did not leave as it wrote it is never put back: an edit made meanwhile is the person's.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { relative } from "node:path"
import { Node, Project, ts, type SourceFile, type TypeLiteralNode, type TypeNode } from "ts-morph"
import { extractSchemaAstFromTypes, walkSchemaSourceAbsPaths } from "./type-extractor.js"
import type { DbColumnState } from "./pull-utils.js"
import type { ExtractedSchemaAstV2, ModelAstV2 } from "./schema-ast-v2.js"

const TYPES_MODULE = "@supatype/types"

/** A live column as `/introspect` reports it, with the precision a `numeric` carries separately. */
export type LiveColumn = DbColumnState & { numericPrecision?: number | null; numericScale?: number | null }

/** A field type built from `@supatype/types` names, rendered once the file's local names are known. */
interface TypeExpr {
  /** A `@supatype/types` export, or a TypeScript keyword (`string`, `boolean`) when `keyword`. */
  name: string
  keyword?: boolean
  args?: Array<TypeExpr | string>
}

/** What reading the schema back must find for the field, so a wrong edit is caught and undone. */
interface ExpectedField {
  kind: string
  required: boolean
  precision?: number
  scale?: number
  /** An identity column's mode, as the AST spells it. */
  identity?: "always" | "byDefault"
  /** `AutoIncrement<>`, which a serial column satisfies. */
  autoIncrement?: true
  /** A generated column's expression. */
  generated?: string
}

export interface ColumnFieldType {
  expr: TypeExpr
  expect: ExpectedField
}

/** Why a column the database fills cannot be declared as one where the engine cannot read it. */
const NO_IDENTITY_COLUMNS =
  "this engine does not support identity and generated columns; update it, or declare the column by hand"

/**
 * The field type whose column is exactly `col`, or why there is none to be sure of.
 *
 * `identityColumns`: whether the engine the schema is pushed to reads identity and generated
 * columns (its `identity_columns` capability). Without it an identity or generated column is not
 * declared as one, since the push would be refused, and a serial is declared as it always was.
 */
export function fieldTypeForColumn(
  col: LiveColumn,
  opts: { localized?: boolean; identityColumns?: boolean } = {},
): ColumnFieldType | { reason: string } {
  const udt = (col.udtName || col.dataType).toLowerCase()
  const base = baseType(udt, col)
  if ("reason" in base) return base
  let expr = base.expr
  // In a localized model a bare `string` is stored as JSONB per locale, which this column is not.
  if (opts.localized === true && base.kind === "text") expr = { name: "NotLocalized", args: [expr] }
  const hasDefault = col.default != null && col.default !== ""
  // How the database fills it, which the introspection says: an identity column numbered from its
  // sequence, or a generated one computed from the row (identity-contract).
  if (col.isIdentity === true || col.isGenerated === true) {
    if (opts.identityColumns !== true) {
      return { reason: `it is ${col.isIdentity === true ? "an identity" : "a generated"} column, and ${NO_IDENTITY_COLUMNS}` }
    }
    if (col.isIdentity === true) return identityFieldType(col, base)
    return generatedFieldType(col, base, expr)
  }
  // A serial (numbered by its default, `nextval` of the sequence it owns) is `AutoIncrement`, which
  // a push leaves exactly as it is.
  if (opts.identityColumns === true && isSerial(col) && (base.kind === "integer" || base.kind === "bigInt")) {
    const width = { name: base.kind === "bigInt" ? "bigint" : "number", keyword: true }
    return {
      expr: { name: "AutoIncrement", args: [width] },
      expect: { kind: base.kind, required: true, identity: "byDefault", autoIncrement: true },
    }
  }
  // The database assigns it, so an insert may leave it out. Its default stays the database's own.
  if (hasDefault) expr = { name: "ServerDefault", args: [expr] }
  if (col.nullable) expr = { name: "Optional", args: [expr] }
  return {
    expr,
    expect: {
      kind: base.kind,
      required: !col.nullable,
      ...(base.precision !== undefined && { precision: base.precision }),
      ...(base.scale !== undefined && { scale: base.scale }),
    },
  }
}

/** A serial column: numbered by its default, `nextval` of a sequence. */
function isSerial(col: LiveColumn): boolean {
  return !col.nullable && typeof col.default === "string" && col.default.startsWith("nextval(")
}

/** The kinds an identity column can have. */
const INTEGER_KINDS = new Set(["smallInt", "integer", "bigInt"])

/**
 * An identity column, in the alias form where it is exact (`Identity<number>`, `Identity<bigint,
 * "by-default">`) and the options form where the alias would read as another width
 * (`SmallInt<{ identity: "always" }>`, since `Identity<SmallInt>` is an `Int` to the type checker).
 */
function identityFieldType(
  col: LiveColumn,
  base: { expr: TypeExpr; kind: string },
): ColumnFieldType | { reason: string } {
  if (!INTEGER_KINDS.has(base.kind)) {
    return { reason: `it is an identity column of type ${col.udtName || col.dataType}, which no field type declares` }
  }
  const identity = col.identityGeneration === "BY DEFAULT" ? "byDefault" : "always"
  const mode = identity === "byDefault" ? "by-default" : "always"
  const modeArg = JSON.stringify(mode)
  const expr: TypeExpr =
    base.kind === "smallInt"
      ? { name: "SmallInt", args: [`{ identity: ${modeArg} }`] }
      : {
          name: "Identity",
          args: [
            { name: base.kind === "bigInt" ? "bigint" : "number", keyword: true },
            ...(mode === "always" ? [] : [modeArg]),
          ],
        }
  return { expr, expect: { kind: base.kind, required: true, identity } }
}

/** The kinds the engine computes a stored generated column for (identity-contract). */
const GENERATED_KINDS = new Set([
  "text", "boolean", "uuid", "smallInt", "integer", "bigInt", "float", "datetime", "date", "bytes",
])

/** A generated column: `Generated<T, "expression">`, the expression as Postgres reports it. */
function generatedFieldType(
  col: LiveColumn,
  base: { kind: string },
  expr: TypeExpr,
): ColumnFieldType | { reason: string } {
  const expression = col.generationExpression ?? ""
  if (!GENERATED_KINDS.has(base.kind) || expression === "") {
    return {
      reason: `it is a generated column of type ${col.udtName || col.dataType}, which no field type declares as one`,
    }
  }
  let generated: TypeExpr = { name: "Generated", args: [expr, JSON.stringify(expression)] }
  if (col.nullable) generated = { name: "Optional", args: [generated] }
  return { expr: generated, expect: { kind: base.kind, required: !col.nullable, generated: expression } }
}

function baseType(
  udt: string,
  col: LiveColumn,
): { expr: TypeExpr; kind: string; precision?: number; scale?: number } | { reason: string } {
  const named = (name: string, kind: string) => ({ expr: { name }, kind })
  switch (udt) {
    case "text":
      return { expr: { name: "string", keyword: true }, kind: "text" }
    case "bool":
      return { expr: { name: "boolean", keyword: true }, kind: "boolean" }
    case "uuid":
      return named("UUID", "uuid")
    case "int2":
      return named("SmallInt", "smallInt")
    case "int4":
      return named("Int", "integer")
    case "int8":
      return named("BigInt", "bigInt")
    case "float8":
      return named("Float", "float")
    case "timestamptz":
      return named("Timestamp", "datetime")
    case "date":
      return named("DateOnly", "date")
    case "bytea":
      return named("Bytea", "bytes")
    case "jsonb":
      return { expr: { name: "JSON", args: ["unknown"] }, kind: "json" }
    case "numeric": {
      const precision = col.numericPrecision ?? undefined
      const scale = col.numericScale ?? undefined
      if (precision === undefined || scale === undefined) {
        return { reason: "it is an unbounded numeric, which no field type declares exactly" }
      }
      return {
        expr: { name: "Decimal", args: [String(precision), String(scale)] },
        kind: "decimal",
        precision,
        scale,
      }
    }
    default:
      return {
        reason:
          `its type ${col.udtName || col.dataType} has no field type that declares exactly that column, ` +
          "so the next push would change it",
      }
  }
}

function render(expr: TypeExpr | string, local: (name: string) => string): string {
  if (typeof expr === "string") return expr
  const head = expr.keyword ? expr.name : local(expr.name)
  return expr.args ? `${head}<${expr.args.map((a) => render(a, local)).join(", ")}>` : head
}

function typeNames(expr: TypeExpr | string, out = new Set<string>()): Set<string> {
  if (typeof expr === "string") return out
  if (!expr.keyword) out.add(expr.name)
  for (const arg of expr.args ?? []) typeNames(arg, out)
  return out
}

/** A field key for `column`: the column name, quoted when it is not an identifier. */
export function fieldKey(column: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(column) ? column : JSON.stringify(column)
}

/** The edit, worked out and not yet made: what to show before asking. */
export interface ColumnDeclarationPlan {
  status: "planned"
  table: string
  column: string
  model: string
  /** Absolute path of the file to edit. */
  file: string
  /** The field as it will read in the file, e.g. `note: Optional<string>`. */
  line: string
  /** `@supatype/types` names the edit adds to the file's import. */
  addsImports: string[]
  /** The file's text before and after. */
  before: string
  after: string
  expect: ExpectedField
  key: string
}

/** What to tell a person to do by hand, and why the CLI did not. */
export interface ColumnDeclarationManual {
  status: "manual"
  table: string
  column: string
  reason: string
  /** The field to add, when the column's type maps to one. */
  line?: string
  /** `@supatype/types` names the line uses, to import. */
  imports?: string[]
  model?: string
  file?: string
}

/** The schema already declares the column: adopting it needs no edit. */
export interface ColumnAlreadyDeclared {
  status: "declared"
  table: string
  column: string
  model: string
}

export type ColumnDeclaration = ColumnDeclarationPlan | ColumnDeclarationManual | ColumnAlreadyDeclared

export interface PlanInput {
  /** Absolute path of the schema entry. */
  entryPath: string
  /** Where relative paths in messages start. */
  cwd: string
  table: string
  column: string
  /** The live column; undefined when the database did not report it. */
  live: LiveColumn | undefined
  /** Whether the engine reads identity and generated columns (`identity_columns`). */
  identityColumns?: boolean
}

/** Work out how to declare an adopted column, without writing anything. */
export function planColumnDeclaration(input: PlanInput): ColumnDeclaration {
  const { table, column } = input
  const manual = (reason: string, extra: Partial<ColumnDeclarationManual> = {}): ColumnDeclarationManual => ({
    status: "manual",
    table,
    column,
    reason,
    ...extra,
  })
  let ast: ExtractedSchemaAstV2 | null
  try {
    ast = extractSchemaAstFromTypes(input.entryPath, input.cwd)
  } catch (err: unknown) {
    if (input.live === undefined) return manual(`the schema could not be read (${messageOf(err)})`)
    return withCanonicalLine(manual(`the schema could not be read (${messageOf(err)})`), input.live, input.identityColumns)
  }
  // Declared already (adopting a table hands over its declared columns too): nothing to add.
  const declaring = (ast?.models ?? []).filter((m) => m.annotations.db.tableName === table && column in m.fields)
  if (declaring.length === 1) return { status: "declared", table, column, model: declaring[0]!.name }
  if (input.live === undefined) {
    return manual(`the database did not report column ${table}.${column}, so its type is not known`)
  }
  const models = (ast?.models ?? []).filter((m) => m.annotations.db.tableName === table)
  if (models.length !== 1) {
    const reason =
      models.length === 0
        ? `no model in the schema has table ${table}`
        : `more than one model has table ${table} (${models.map((m) => m.name).join(", ")})`
    return withCanonicalLine(manual(reason), input.live, input.identityColumns)
  }
  const model = models[0]!

  const found = findModelDeclaration(input.entryPath, model.name)
  if ("reason" in found) {
    return withCanonicalLine(manual(found.reason, { model: model.name }), input.live, input.identityColumns)
  }
  const { sourceFile, fields, localized } = found
  const file = sourceFile.getFilePath()
  const at = { model: model.name, file }

  const type = fieldTypeForColumn(input.live, {
    localized,
    ...(input.identityColumns !== undefined && { identityColumns: input.identityColumns }),
  })
  if ("reason" in type) return manual(`column ${table}.${column} cannot be declared exactly: ${type.reason}`, at)

  const key = fieldKey(column)
  const canonical = `${key}: ${render(type.expr, (n) => n)}`
  const canonicalImports = [...typeNames(type.expr)]
  const asManual = (reason: string) => manual(reason, { ...at, line: canonical, imports: canonicalImports })

  if (column in model.fields || hasMember(fields, column)) {
    return { status: "declared", table, column, model: model.name }
  }

  const imports = importEdits(sourceFile, canonicalImports)
  if ("reason" in imports) return asManual(imports.reason)
  const line = `${key}: ${render(type.expr, (n) => imports.local.get(n) ?? n)}`

  const fieldEdit = fieldInsertion(sourceFile, fields, line)
  const before = sourceFile.getFullText()
  const after = applyEdits(before, [...imports.edits, fieldEdit])
  return {
    status: "planned",
    table,
    column,
    model: model.name,
    file,
    line,
    addsImports: imports.added,
    before,
    after,
    expect: type.expect,
    key: column,
  }
}

function withCanonicalLine(
  manual: ColumnDeclarationManual,
  live: LiveColumn | undefined,
  identityColumns: boolean | undefined,
): ColumnDeclarationManual {
  if (live === undefined) return manual
  const type = fieldTypeForColumn(live, { ...(identityColumns !== undefined && { identityColumns }) })
  if ("reason" in type) return { ...manual, reason: `${manual.reason}; and ${type.reason}` }
  return {
    ...manual,
    line: `${fieldKey(manual.column)}: ${render(type.expr, (n) => n)}`,
    imports: [...typeNames(type.expr)],
  }
}

/**
 * Make the planned edit, then read the schema back: the field must be there, as planned, and the
 * file must still parse. If not, or the write fails, the file is put back as it was.
 */
export function applyColumnDeclaration(plan: ColumnDeclarationPlan, entryPath: string, cwd: string): ColumnDeclaration {
  const manual = (reason: string): ColumnDeclarationManual => ({
    status: "manual",
    table: plan.table,
    column: plan.column,
    reason,
    line: plan.line,
    ...(plan.addsImports.length > 0 && { imports: plan.addsImports }),
    model: plan.model,
    file: plan.file,
  })
  // Put back only what this wrote: a file that is no longer exactly `after` holds someone's edit.
  const undo = (reason: string): ColumnDeclarationManual => {
    try {
      if (readFileSync(plan.file, "utf8") !== plan.after) {
        return manual(`${reason}; the file has changed since it was edited, so it was left as it is`)
      }
      writeFileSync(plan.file, plan.before, "utf8")
    } catch {
      return manual(`${reason}; the file could not be put back, so check it`)
    }
    return manual(`${reason}, so it was put back`)
  }
  try {
    if (readFileSync(plan.file, "utf8") !== plan.before) {
      // Edited while the person was asked: theirs, and left exactly as it is.
      return manual("the file changed since the edit was worked out, so it was left as it is")
    }
    writeFileSync(plan.file, plan.after, "utf8")
  } catch (err: unknown) {
    // Nothing of ours is known to be in it: a failed write is not undone over whatever is there.
    return manual(`the file could not be written (${messageOf(err)})`)
  }
  const problem = verify(plan, entryPath, cwd)
  return problem === undefined ? plan : undo(`the edited schema did not read back as planned (${problem})`)
}

function verify(plan: ColumnDeclarationPlan, entryPath: string, cwd: string): string | undefined {
  const parsed = ts.transpileModule(plan.after, { reportDiagnostics: true, fileName: plan.file })
  if ((parsed.diagnostics ?? []).length > 0) return "the file no longer parses"
  const duplicate = duplicateIdentifier(plan.file, plan.after)
  if (duplicate !== undefined) return duplicate
  let ast: ExtractedSchemaAstV2 | null
  try {
    ast = extractSchemaAstFromTypes(entryPath, cwd)
  } catch (err: unknown) {
    return messageOf(err)
  }
  const models = (ast?.models ?? []).filter((m) => m.annotations.db.tableName === plan.table)
  if (models.length !== 1 || models[0]!.name !== plan.model) return `model ${plan.model} is not found`
  const field = models[0]!.fields[plan.key]
  if (field === undefined) return `field ${plan.key} is not found`
  return fieldMismatch(field, plan.expect)
}

/** Errors that mean a name is bound twice (TS2300 and kin), which parsing alone does not report. */
const DUPLICATE_CODES = new Set([2300, 2440, 2395])

/** The first "duplicate identifier" kind of error in `text`, checked as one file on its own. */
function duplicateIdentifier(fileName: string, text: string): string | undefined {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [], noEmit: true }
  const host = ts.createCompilerHost(options)
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, ...rest) => (name === fileName ? source : getSourceFile(name, ...rest))
  const program = ts.createProgram([fileName], options, host)
  const found = program.getSemanticDiagnostics(source).find((d) => DUPLICATE_CODES.has(d.code))
  if (found !== undefined) return ts.flattenDiagnosticMessageText(found.messageText, " ")
  // With the module unresolved the checker cannot see an import clash with the file's own type, so
  // that one is looked for directly.
  const file = new Project({ useInMemoryFileSystem: true }).createSourceFile(fileName, text, { overwrite: true })
  for (const decl of file.getImportDeclarations()) {
    for (const spec of decl.getNamedImports()) {
      const name = spec.getAliasNode()?.getText() ?? spec.getName()
      if (declaredLocally(file, name)) return `Import declaration conflicts with local declaration of '${name}'.`
    }
  }
  return undefined
}

function fieldMismatch(field: ModelAstV2["fields"][string], expect: ExpectedField): string | undefined {
  if (field.kind !== expect.kind) return `it reads as ${field.kind}, not ${expect.kind}`
  if (field["required"] !== expect.required) return "its nullability differs"
  if (field["localized"] === true) return "it reads as localized"
  if (expect.precision !== undefined && field["precision"] !== expect.precision) return "its precision differs"
  if (expect.scale !== undefined && field["scale"] !== expect.scale) return "its scale differs"
  if (field["identity"] !== expect.identity) return "its identity differs"
  if (field["autoIncrement"] !== expect.autoIncrement) return "it reads as another kind of identity"
  const generated = (field["generated"] as { expression?: unknown } | undefined)?.expression
  if (generated !== expect.generated) return "its generated expression differs"
  return undefined
}

// ─── Finding the model ─────────────────────────────────────────────────────────

const FIELD_WRAPPERS = new Set(["WithTimestamps", "WithSoftDelete", "WithPublishable"])

function findModelDeclaration(
  entryPath: string,
  modelName: string,
): { sourceFile: SourceFile; fields: TypeLiteralNode; localized: boolean } | { reason: string } {
  let paths: string[]
  try {
    paths = walkSchemaSourceAbsPaths(entryPath)
  } catch (err: unknown) {
    return { reason: `the schema files could not be read (${messageOf(err)})` }
  }
  const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true })
  const declarations = []
  for (const path of paths) {
    const sourceFile = project.createSourceFile(path, readFileSync(path, "utf8"), { overwrite: true })
    const alias = sourceFile.getTypeAlias(modelName)
    if (alias?.isExported()) declarations.push({ sourceFile, alias })
  }
  if (declarations.length !== 1) {
    return {
      reason:
        declarations.length === 0
          ? `model ${modelName} is not declared as \`export type ${modelName} = Model<…>\` in a schema file`
          : `model ${modelName} is declared in more than one schema file`,
    }
  }
  const { sourceFile, alias } = declarations[0]!
  const type = alias.getTypeNode()
  if (type === undefined || !Node.isTypeReference(type)) {
    return { reason: `model ${modelName} is not written as Model<{ … }>` }
  }
  const head = type.getTypeName().getText()
  if (head !== "Model" && head !== "LocalizedModel") {
    return { reason: `model ${modelName} is not written as Model<{ … }>` }
  }
  const [fieldsArg, metaArg] = type.getTypeArguments()
  const fields = fieldsArg === undefined ? undefined : inlineFields(fieldsArg)
  if (fields === undefined) {
    return {
      reason:
        `model ${modelName}'s fields are not written inline in its Model<{ … }>, ` +
        "so which declaration should hold the field is not for the CLI to choose",
    }
  }
  return { sourceFile, fields, localized: head === "LocalizedModel" || declaresAutoLocalize(metaArg) }
}

function inlineFields(node: TypeNode): TypeLiteralNode | undefined {
  if (Node.isTypeLiteral(node)) return node
  if (Node.isTypeReference(node) && FIELD_WRAPPERS.has(node.getTypeName().getText())) {
    const inner = node.getTypeArguments()[0]
    return inner === undefined ? undefined : inlineFields(inner)
  }
  return undefined
}

function declaresAutoLocalize(meta: TypeNode | undefined): boolean {
  if (meta === undefined || !Node.isTypeLiteral(meta)) return false
  return meta.getProperties().some((p) => memberName(p) === "autoLocalize" && p.getTypeNode()?.getText() === "true")
}

function memberName(member: Node): string | undefined {
  if (!Node.isPropertySignature(member)) return undefined
  const name = member.getNameNode()
  if (Node.isStringLiteral(name) || Node.isNoSubstitutionTemplateLiteral(name)) return name.getLiteralValue()
  return name.getText()
}

function hasMember(fields: TypeLiteralNode, name: string): boolean {
  return fields.getMembers().some((m) => memberName(m) === name)
}

// ─── Text edits ────────────────────────────────────────────────────────────────

interface TextEdit {
  pos: number
  text: string
}

/** The file's own line ending, so an inserted line matches the lines around it. */
function lineEnding(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function applyEdits(text: string, edits: TextEdit[]): string {
  let out = text
  for (const edit of [...edits].sort((a, b) => b.pos - a.pos)) {
    out = out.slice(0, edit.pos) + edit.text + out.slice(edit.pos)
  }
  return out
}

/** Append `line` as the last member of `fields`, in the style the literal already uses. */
function fieldInsertion(sourceFile: SourceFile, fields: TypeLiteralNode, line: string): TextEdit {
  const text = sourceFile.getFullText()
  const members = fields.getMembers()
  const last = members.at(-1)
  if (last === undefined) {
    const open = fields.getStart() + 1
    return { pos: open, text: ` ${line} ` }
  }
  const lastText = last.getText()
  const sep = lastText.endsWith(";") ? ";" : lastText.endsWith(",") ? "," : ""
  const end = last.getEnd()
  const lineEnd = text.indexOf("\n", end)
  const restOfLine = text.slice(end, lineEnd === -1 ? text.length : lineEnd)
  const closesOnLine = restOfLine.includes("}")
  if (closesOnLine || lineEnd === -1) {
    // `{ a: string }` on one line: keep it on one line.
    return { pos: end, text: sep === "" ? `; ${line}` : ` ${line}${sep}` }
  }
  // After anything else on the last member's line (a trailing comment stays with its field), and
  // before its line ending, which the new line ends with too: a CRLF file stays CRLF.
  const lineStart = text.lastIndexOf("\n", last.getStart()) + 1
  const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? ""
  const crlf = text[lineEnd - 1] === "\r"
  return { pos: crlf ? lineEnd - 1 : lineEnd, text: `${crlf ? "\r\n" : "\n"}${indent}${line}${sep}` }
}

/**
 * The local name of each `@supatype/types` name, and the edits that import the missing ones into
 * an existing named import from it.
 */
function importEdits(
  sourceFile: SourceFile,
  names: readonly string[],
): { local: Map<string, string>; edits: TextEdit[]; added: string[] } | { reason: string } {
  const decls = sourceFile.getImportDeclarations().filter((d) => d.getModuleSpecifierValue() === TYPES_MODULE)
  const local = new Map<string, string>()
  for (const decl of decls) {
    for (const spec of decl.getNamedImports()) {
      const name = spec.getName()
      if (names.includes(name) && !local.has(name)) local.set(name, spec.getAliasNode()?.getText() ?? name)
    }
  }
  const missing = names.filter((n) => !local.has(n))
  if (missing.length === 0) return { local, edits: [], added: [] }

  // Importing a name the file already binds (another import, or its own type) would declare it
  // twice: refused, for a person to alias, rather than written.
  const taken = missing.filter((n) => boundLocally(sourceFile, n))
  if (taken.length > 0) {
    return {
      reason:
        `${relativeName(sourceFile)} already has ${taken.map((n) => `a ${n}`).join(" and ")} that is not ` +
        `"${TYPES_MODULE}"'s, so importing ${taken.length === 1 ? "it" : "them"} would declare the name twice; ` +
        `import ${taken.join(", ")} from "${TYPES_MODULE}" under another name and use that`,
    }
  }

  const target = decls.find((d) => d.getNamedImports().length > 0 && d.getNamespaceImport() === undefined)
  if (target === undefined) {
    return { reason: `${relativeName(sourceFile)} has no named import from "${TYPES_MODULE}" to add ${missing.join(", ")} to` }
  }
  // A type in a value import must say so, or `verbatimModuleSyntax` refuses it.
  const spelled = missing.map((n) => (target.isTypeOnly() ? n : `type ${n}`))
  for (const n of missing) local.set(n, n)

  const text = sourceFile.getFullText()
  const elements = target.getNamedImports()
  const last = elements.at(-1)!
  const end = last.getEnd()
  const close = text.indexOf("}", end)
  const between = text.slice(end, close)
  const trailingComma = between.trimStart().startsWith(",")
  const multiline = text.slice(elements[0]!.getStart(), close).includes("\n")
  if (!multiline) return { local, edits: [{ pos: end, text: spelled.map((n) => `, ${n}`).join("") }], added: missing }

  const lineStart = text.lastIndexOf("\n", last.getStart()) + 1
  const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? ""
  const eol = lineEnding(text)
  if (trailingComma) {
    const pos = end + between.indexOf(",") + 1
    return { local, edits: [{ pos, text: spelled.map((n) => `${eol}${indent}${n},`).join("") }], added: missing }
  }
  return { local, edits: [{ pos: end, text: spelled.map((n) => `,${eol}${indent}${n}`).join("") }], added: missing }
}

/** Whether `name` is already bound at the top of the file: by an import, or a declaration. */
function boundLocally(sourceFile: SourceFile, name: string): boolean {
  for (const decl of sourceFile.getImportDeclarations()) {
    if (decl.getDefaultImport()?.getText() === name) return true
    if (decl.getNamespaceImport()?.getText() === name) return true
    for (const spec of decl.getNamedImports()) {
      if ((spec.getAliasNode()?.getText() ?? spec.getName()) === name) return true
    }
    // `import X = require(...)` and the like are rare enough to leave to the read-back.
  }
  return declaredLocally(sourceFile, name)
}

/** Whether the file declares `name` itself, at the top level. */
function declaredLocally(sourceFile: SourceFile, name: string): boolean {
  return (
    sourceFile.getTypeAlias(name) !== undefined ||
    sourceFile.getInterface(name) !== undefined ||
    sourceFile.getClass(name) !== undefined ||
    sourceFile.getEnum(name) !== undefined ||
    sourceFile.getFunction(name) !== undefined ||
    sourceFile.getVariableDeclaration(name) !== undefined ||
    sourceFile.getModule(name) !== undefined
  )
}

function relativeName(sourceFile: SourceFile): string {
  return relative(process.cwd(), sourceFile.getFilePath()) || sourceFile.getFilePath()
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ─── Before adopt ──────────────────────────────────────────────────────────────

/** `column:<table>.<name>`, as `--key` names a column; undefined for any other key. */
export function parseColumnKey(key: string): { table: string; column: string } | undefined {
  if (!key.startsWith("column:")) return undefined
  const rest = key.slice("column:".length)
  const dot = rest.indexOf(".")
  if (dot <= 0 || dot === rest.length - 1) return undefined
  return { table: rest.slice(0, dot), column: rest.slice(dot + 1) }
}

/**
 * What adopt will do with each column `--key` names that the engine's preview does not list (a
 * column added outside Supatype is not a conflict, so the preview is silent about it): one line
 * per column, saying the field that would be added and where, worked out by the same planning the
 * edit after adopt uses, or that it has to be added by hand. Nothing is written.
 */
export async function previewKeyedColumns(
  keys: readonly string[],
  shown: readonly string[],
  opts: { entryPath: string; cwd: string; identityColumns?: boolean },
  deps: { introspect: () => Promise<unknown> },
): Promise<string[]> {
  const columns = keys
    .filter((key) => !shown.includes(key))
    .map(parseColumnKey)
    .filter((c): c is { table: string; column: string } => c !== undefined)
  if (columns.length === 0) return []

  let live: Map<string, LiveColumn> | undefined
  let unread: string | undefined
  try {
    live = liveColumns(await deps.introspect())
  } catch (err: unknown) {
    unread = messageOf(err)
  }

  return columns.map(({ table, column }) => {
    const head = `column ${table}.${column}: record as managed by Supatype`
    if (live === undefined) {
      return `${head}; its type could not be read from the database (${unread ?? "no answer"}), so declare it in your schema by hand`
    }
    const plan = planColumnDeclaration({
      entryPath: opts.entryPath,
      cwd: opts.cwd,
      table,
      column,
      live: live.get(`${table}.${column}`),
      ...(opts.identityColumns !== undefined && { identityColumns: opts.identityColumns }),
    })
    if (plan.status === "declared") return `${head}; the schema already declares it (${plan.model})`
    if (plan.status === "planned") {
      const imports =
        plan.addsImports.length > 0 ? `, importing ${plan.addsImports.join(", ")} from "${TYPES_MODULE}"` : ""
      return `${head}, and add \`${plan.line}\` to ${displayPath(plan.file, opts.cwd)} (${plan.model})${imports}`
    }
    if (plan.line === undefined) return `${head}; declare it in your schema by hand (${plan.reason})`
    const where =
      plan.model !== undefined
        ? ` in ${plan.file !== undefined ? `${displayPath(plan.file, opts.cwd)} (${plan.model})` : `model ${plan.model}`}`
        : ""
    return `${head}; add it to your schema by hand${where}: \`${plan.line}\` (${plan.reason})`
  })
}

// ─── After adopt ───────────────────────────────────────────────────────────────

/** An object adopt took, as the engine names it. */
export interface AdoptedObject {
  kind: string
  table: string
  name: string
}

export interface DeclareOptions {
  entryPath: string
  cwd: string
  /** `--yes`: the adopt and the schema edit it implies were both agreed to. */
  yes: boolean
  /** Whether a person can be asked. */
  interactive: boolean
  /** Whether the engine reads identity and generated columns (`identity_columns`). */
  identityColumns?: boolean
}

export interface DeclareDeps {
  /** The live database, as `/introspect` reports it. */
  introspect: () => Promise<unknown>
  confirm: (question: string) => Promise<boolean>
  /** What `supatype generate` does; the messages it prints. */
  regenerate: () => Promise<string[]>
  say: { info: (m: string) => void; warn: (m: string) => void; plain: (m: string) => void }
}

/**
 * Declare every column adopt took in the schema, asking first unless `--yes`, and regenerate types
 * once if any file changed. What cannot be declared exactly is printed for a person to add; the
 * adopt has happened either way, so nothing here fails the command.
 */
export async function declareAdoptedColumns(
  adopted: readonly AdoptedObject[],
  opts: DeclareOptions,
  deps: DeclareDeps,
): Promise<ColumnDeclaration[]> {
  // A table adopted with its columns: the engine lists each declared column it took as well, and a
  // column the schema does not declare is adopted only on a table Supatype already owns, so every
  // one of these is declared already.
  const tables = new Set(adopted.filter((item) => item.kind === "table").map((item) => item.name))
  const columns = adopted.filter((item) => item.kind === "column" && !tables.has(item.table))
  if (columns.length === 0) return []

  let live: Map<string, LiveColumn> | undefined
  try {
    live = liveColumns(await deps.introspect())
  } catch (err: unknown) {
    deps.say.warn(`Could not read the adopted column(s) from the database: ${messageOf(err)}`)
  }

  const results: ColumnDeclaration[] = []
  for (const item of columns) {
    const planned = planColumnDeclaration({
      entryPath: opts.entryPath,
      cwd: opts.cwd,
      table: item.table,
      column: item.name,
      live: live?.get(`${item.table}.${item.name}`),
      ...(opts.identityColumns !== undefined && { identityColumns: opts.identityColumns }),
    })
    if (planned.status !== "planned") {
      results.push(planned)
      continue
    }
    const where = `model ${planned.model} in ${displayPath(planned.file, opts.cwd)}`
    if (!opts.yes) {
      deps.say.plain(`\nColumn ${item.table}.${item.name} is now Supatype's, so the schema should declare it.`)
      deps.say.plain(`Add to ${where}:\n`)
      deps.say.plain(`  ${planned.line}`)
      if (planned.addsImports.length > 0) {
        deps.say.plain(`\n  (and import ${planned.addsImports.join(", ")} from "${TYPES_MODULE}")`)
      }
      const agreed = opts.interactive && (await deps.confirm(`Edit ${displayPath(planned.file, opts.cwd)}?`))
      if (!agreed) {
        results.push({
          status: "manual",
          table: item.table,
          column: item.name,
          reason: opts.interactive ? "you chose not to edit the file" : "there was no one to ask",
          line: planned.line,
          ...(planned.addsImports.length > 0 && { imports: planned.addsImports }),
          model: planned.model,
          file: planned.file,
        })
        continue
      }
    }
    const applied = applyColumnDeclaration(planned, opts.entryPath, opts.cwd)
    if (applied.status === "planned") {
      deps.say.info(`Added \`${applied.line}\` to ${where}.`)
    }
    results.push(applied)
  }

  for (const result of results) {
    if (result.status === "manual") printManual(result, opts.cwd, deps.say)
  }

  const declared = results.filter((r): r is ColumnDeclarationPlan => r.status === "planned")
  if (declared.length > 0) {
    try {
      for (const message of await deps.regenerate()) deps.say.info(message)
    } catch (err: unknown) {
      deps.say.warn(`Types were not regenerated (${messageOf(err)}); run \`supatype generate\`.`)
    }
    const names = declared.map((d) => `${d.table}.${d.column}`).join(", ")
    deps.say.plain(`The next \`supatype push\` treats ${names} as declared field(s).`)
  }
  return results
}

function printManual(result: ColumnDeclarationManual, cwd: string, say: DeclareDeps["say"]): void {
  say.warn(`Column ${result.table}.${result.column} was adopted, but the schema was not edited: ${result.reason}.`)
  const where =
    result.model !== undefined && result.file !== undefined
      ? `model ${result.model} in ${displayPath(result.file, cwd)}`
      : result.model !== undefined
        ? `model ${result.model}`
        : `the model whose table is ${result.table}`
  if (result.line === undefined) {
    say.plain(`Declare a field ${result.column} for it on ${where}, so the schema says what the column is.`)
    return
  }
  say.plain(`Add this field to ${where} by hand:\n`)
  say.plain(`  ${result.line}`)
  if (result.imports !== undefined && result.imports.length > 0) {
    say.plain(`\n  (importing ${result.imports.join(", ")} from "${TYPES_MODULE}")`)
  }
  say.plain("")
}

function liveColumns(state: unknown): Map<string, LiveColumn> {
  const out = new Map<string, LiveColumn>()
  const tables = (state as { tables?: unknown } | null)?.tables
  if (!Array.isArray(tables)) return out
  for (const table of tables as Array<{ name?: unknown; columns?: unknown }>) {
    if (typeof table.name !== "string" || !Array.isArray(table.columns)) continue
    for (const col of table.columns as LiveColumn[]) {
      if (typeof col?.name === "string") out.set(`${table.name}.${col.name}`, col)
    }
  }
  return out
}

function displayPath(file: string, cwd: string): string {
  const rel = relative(cwd, file)
  return rel === "" || rel.startsWith("..") ? file : rel
}
