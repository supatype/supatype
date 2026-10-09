/**
 * Adopting a column declares it.
 *
 * `supatype adopt column:<table>.<name>` hands Supatype a column someone added outside the schema
 * (engine: it is recorded in the ledger and its narrowed write grant includes it). Adopted means
 * managed, and a managed column is one the schema declares, so the CLI then adds the field to the
 * model whose table it is, and regenerates types: from the next push it is an ordinary field.
 *
 * Rewriting someone's source is only done when it can be done exactly, and only when a person says
 * so at a prompt. The field key is the column name (a field's key is its column, verbatim: the
 * engine does not convert case), its type is one whose column is exactly the live one, so the next
 * push changes nothing, and the edit is checked by reading the schema back. Otherwise, or when the
 * person declines, cannot be asked, or passed `--yes` (which agrees to the adopt, not to edits of
 * their files), the file is untouched and the CLI prints the line to add and where.
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
}

export interface ColumnFieldType {
  expr: TypeExpr
  expect: ExpectedField
}

/** The field type whose column is exactly `col`, or why there is none to be sure of. */
export function fieldTypeForColumn(col: LiveColumn, opts: { localized?: boolean } = {}): ColumnFieldType | { reason: string } {
  const udt = (col.udtName || col.dataType).toLowerCase()
  const base = baseType(udt, col)
  if ("reason" in base) return base
  let expr = base.expr
  // In a localized model a bare `string` is stored as JSONB per locale, which this column is not.
  if (opts.localized === true && base.kind === "text") expr = { name: "NotLocalized", args: [expr] }
  // The database assigns it, so an insert may leave it out. Its default stays the database's own.
  if (col.default != null && col.default !== "") expr = { name: "ServerDefault", args: [expr] }
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

export type ColumnDeclaration = ColumnDeclarationPlan | ColumnDeclarationManual

export interface PlanInput {
  /** Absolute path of the schema entry. */
  entryPath: string
  /** Where relative paths in messages start. */
  cwd: string
  table: string
  column: string
  /** The live column; undefined when the database did not report it. */
  live: LiveColumn | undefined
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
  if (input.live === undefined) {
    return manual(`the database did not report column ${table}.${column}, so its type is not known`)
  }

  let ast: ExtractedSchemaAstV2 | null
  try {
    ast = extractSchemaAstFromTypes(input.entryPath, input.cwd)
  } catch (err: unknown) {
    return withCanonicalLine(manual(`the schema could not be read (${messageOf(err)})`), input.live)
  }
  const models = (ast?.models ?? []).filter((m) => m.annotations.db.tableName === table)
  if (models.length !== 1) {
    const reason =
      models.length === 0
        ? `no model in the schema has table ${table}`
        : `more than one model has table ${table} (${models.map((m) => m.name).join(", ")})`
    return withCanonicalLine(manual(reason), input.live)
  }
  const model = models[0]!

  const found = findModelDeclaration(input.entryPath, model.name)
  if ("reason" in found) return withCanonicalLine(manual(found.reason, { model: model.name }), input.live)
  const { sourceFile, fields, localized } = found
  const file = sourceFile.getFilePath()
  const at = { model: model.name, file }

  const type = fieldTypeForColumn(input.live, { localized })
  if ("reason" in type) return manual(`column ${table}.${column} cannot be declared exactly: ${type.reason}`, at)

  const key = fieldKey(column)
  const canonical = `${key}: ${render(type.expr, (n) => n)}`
  const canonicalImports = [...typeNames(type.expr)]
  const asManual = (reason: string) => manual(reason, { ...at, line: canonical, imports: canonicalImports })

  if (column in model.fields || hasMember(fields, column)) {
    return asManual(`model ${model.name} already has a field named ${column}`)
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

function withCanonicalLine(manual: ColumnDeclarationManual, live: LiveColumn): ColumnDeclarationManual {
  const type = fieldTypeForColumn(live)
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
  const undo = (reason: string): ColumnDeclarationManual => {
    try {
      if (readFileSync(plan.file, "utf8") !== plan.before) writeFileSync(plan.file, plan.before, "utf8")
    } catch {
      /* the write itself failed, so the file is as it was */
    }
    return {
      status: "manual",
      table: plan.table,
      column: plan.column,
      reason,
      line: plan.line,
      ...(plan.addsImports.length > 0 && { imports: plan.addsImports }),
      model: plan.model,
      file: plan.file,
    }
  }
  try {
    if (readFileSync(plan.file, "utf8") !== plan.before) {
      return undo("the file changed since the edit was worked out")
    }
    writeFileSync(plan.file, plan.after, "utf8")
  } catch (err: unknown) {
    return undo(`the file could not be written (${messageOf(err)})`)
  }
  const problem = verify(plan, entryPath, cwd)
  return problem === undefined ? plan : undo(`the edited schema did not read back as planned (${problem}), so it was put back`)
}

function verify(plan: ColumnDeclarationPlan, entryPath: string, cwd: string): string | undefined {
  const parsed = ts.transpileModule(plan.after, { reportDiagnostics: true, fileName: plan.file })
  if ((parsed.diagnostics ?? []).length > 0) return "the file no longer parses"
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

function fieldMismatch(field: ModelAstV2["fields"][string], expect: ExpectedField): string | undefined {
  if (field.kind !== expect.kind) return `it reads as ${field.kind}, not ${expect.kind}`
  if (field["required"] !== expect.required) return "its nullability differs"
  if (field["localized"] === true) return "it reads as localized"
  if (expect.precision !== undefined && field["precision"] !== expect.precision) return "its precision differs"
  if (expect.scale !== undefined && field["scale"] !== expect.scale) return "its scale differs"
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
  // After anything else on the last member's line (a trailing comment stays with its field).
  const lineStart = text.lastIndexOf("\n", last.getStart()) + 1
  const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? ""
  return { pos: lineEnd, text: `\n${indent}${line}${sep}` }
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
  if (trailingComma) {
    const pos = end + between.indexOf(",") + 1
    return { local, edits: [{ pos, text: spelled.map((n) => `\n${indent}${n},`).join("") }], added: missing }
  }
  return { local, edits: [{ pos: end, text: spelled.map((n) => `,\n${indent}${n}`).join("") }], added: missing }
}

function relativeName(sourceFile: SourceFile): string {
  return relative(process.cwd(), sourceFile.getFilePath()) || sourceFile.getFilePath()
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
  const columns = adopted.filter((item) => item.kind === "column")
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
    })
    if (planned.status === "manual") {
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
