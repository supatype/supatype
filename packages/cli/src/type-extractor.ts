import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import ts from "typescript"

type FieldAst = Record<string, unknown> & { kind: string }
type BlockDefinitionAst = {
  name: string
  label?: string
  icon?: string
  fields: Record<string, FieldAst>
}

interface ModelAst {
  name: string
  tableName: string
  fields: Record<string, FieldAst>
  access: Record<string, unknown>
  indexes: unknown[]
  options: Record<string, unknown>
}

/** Resolved row for `storage.buckets` — matches engine `StorageBucketAst` (camelCase JSON). */
export interface ExtractedStorageBucketAst {
  id: string
  public: boolean
  /** `public` / `private` / `custom` — drives DB `access_mode` and S3 helpers (engine + storage server). */
  accessMode?: "public" | "private" | "custom"
  allowedMimeTypes?: string[]
  fileSizeLimit?: number
  /** Bucket-scoped `storage.objects` RLS (`read`, `create`, `delete`). */
  access?: Record<string, unknown>
  /** Raw S3 bucket policy JSON; overrides default public-read when `public` is true if set. */
  s3BucketPolicy?: string
}

export interface ExtractedSchemaAst {
  models: ModelAst[]
  storageBuckets?: ExtractedStorageBucketAst[]
}

export function extractSchemaAstFromTypes(
  schemaPath: string,
  cwd: string = process.cwd(),
): ExtractedSchemaAst | null {
  const absPath = resolve(cwd, schemaPath)
  if (!existsSync(absPath)) {
    throw new Error(`Schema file not found: ${absPath}`)
  }

  const sourceFiles = loadSchemaSourceFiles(absPath)
  const bucketAliases = new Map<string, string>()
  const bucketsById = new Map<string, ExtractedStorageBucketAst>()
  for (const sourceFile of sourceFiles) {
    const bucketContext = collectBucketContext(sourceFile)
    for (const [alias, bucketId] of bucketContext.aliases) {
      bucketAliases.set(alias, bucketId)
    }
    for (const [bucketId, bucket] of bucketContext.bucketsById) {
      const existing = bucketsById.get(bucketId)
      if (existing !== undefined && !bucketsEqual(existing, bucket)) {
        throw new Error(
          `Conflicting Bucket<> declarations for id "${bucketId}". Use a single export per bucket id.`,
        )
      }
      bucketsById.set(bucketId, bucket)
    }
  }

  const blockAliases = new Map<string, BlockDefinitionAst>()
  for (const sourceFile of sourceFiles) {
    const next = collectBlockAliases(sourceFile, bucketAliases, bucketsById)
    for (const [name, block] of next) {
      blockAliases.set(name, block)
    }
  }

  const models: ModelAst[] = []

  for (const sourceFile of sourceFiles) {
    for (const stmt of sourceFile.statements) {
      if (!ts.isTypeAliasDeclaration(stmt)) continue
      if (!hasExportModifier(stmt)) continue
      if (!ts.isTypeReferenceNode(stmt.type)) continue
      if (stmt.type.typeName.getText(sourceFile) !== "Model") continue
      const [fieldsArg, metaArg] = stmt.type.typeArguments ?? []
      if (!fieldsArg) continue
      const fieldsLiteral = unwrapModelFields(fieldsArg)
      if (!fieldsLiteral) continue

      const fields: Record<string, FieldAst> = {}
      for (const member of fieldsLiteral.members) {
        if (!ts.isPropertySignature(member) || !member.type) continue
        const name = getPropertyName(member.name)
        if (!name) continue
        fields[name] = parseFieldType(
          name,
          member.type,
          sourceFile,
          blockAliases,
          bucketAliases,
          bucketsById,
        )
      }

      models.push({
        name: stmt.name.text,
        tableName: toSnakeCase(stmt.name.text),
        fields,
        access: parseModelAccess(metaArg, sourceFile),
        indexes: [],
        options: {},
      })
    }
  }

  if (models.length === 0) return null

  const storageBuckets =
    bucketsById.size > 0 ? [...bucketsById.values()].sort((a, b) => a.id.localeCompare(b.id)) : undefined

  return {
    models,
    ...(storageBuckets !== undefined && storageBuckets.length > 0 && { storageBuckets }),
  }
}

function loadSchemaSourceFiles(entryPath: string): ts.SourceFile[] {
  const visited = new Set<string>()
  const sourceFiles: ts.SourceFile[] = []
  const queue: string[] = [entryPath]

  while (queue.length > 0) {
    const currentPath = queue.shift()
    if (!currentPath) continue
    if (visited.has(currentPath)) continue
    visited.add(currentPath)

    if (!existsSync(currentPath)) continue
    const sourceText = readFileSync(currentPath, "utf8")
    const sourceFile = ts.createSourceFile(currentPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    sourceFiles.push(sourceFile)

    const baseDir = dirname(currentPath)
    for (const stmt of sourceFile.statements) {
      if (!ts.isExportDeclaration(stmt)) continue
      if (!stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
      const nextPath = resolveTypeModulePath(baseDir, stmt.moduleSpecifier.text)
      if (!nextPath) continue
      if (!visited.has(nextPath)) queue.push(nextPath)
    }
  }

  return sourceFiles
}

function resolveTypeModulePath(fromDir: string, specifier: string): string | null {
  const basePath = isAbsolute(specifier) ? specifier : resolve(fromDir, specifier)
  const candidates = specifier.endsWith(".js")
    ? [
        basePath,
        basePath.replace(/\.js$/i, ".ts"),
        basePath.replace(/\.js$/i, ".tsx"),
        basePath.replace(/\.js$/i, ".d.ts"),
      ]
    : [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        `${basePath}.d.ts`,
        resolve(basePath, "index.ts"),
        resolve(basePath, "index.tsx"),
        resolve(basePath, "index.d.ts"),
      ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false
  return (ts.getModifiers(node)?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword) ?? false)
}

function getPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

function unwrapModelFields(typeNode: ts.TypeNode): ts.TypeLiteralNode | null {
  if (ts.isTypeLiteralNode(typeNode)) return typeNode
  if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return null

  // Composite helpers in @supatype/types wrap the concrete field object.
  if (
    typeNode.typeName.text === "WithTimestamps" ||
    typeNode.typeName.text === "WithSoftDelete" ||
    typeNode.typeName.text === "WithPublishable"
  ) {
    const inner = typeNode.typeArguments?.[0]
    if (!inner) return null
    return unwrapModelFields(inner)
  }

  return null
}

function parseFieldType(
  fieldName: string,
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
  blockAliases: Map<string, BlockDefinitionAst>,
  bucketAliases: Map<string, string>,
  bucketsById: Map<string, ExtractedStorageBucketAst>,
): FieldAst {
  const flags = {
    required: true,
    unique: false,
    index: false,
    primaryKey: false,
    serverGenerated: false,
    autoIncrement: false,
    relationCardinality: undefined as "one" | "many" | undefined,
    relationTarget: undefined as string | undefined,
    editorReadOnly: false,
    /** When set from `ComputedFrom`, Studio previews from these sources until edited on create */
    computedFromSources: undefined as string[] | undefined,
    /** When set, second arg was a template literal with `{field}` / `{truncate(f, n)}` */
    computedFromTemplate: undefined as string | undefined,
  }

  let current = typeNode
  while (ts.isTypeReferenceNode(current) && ts.isIdentifier(current.typeName)) {
    const typeName = current.typeName.text
    switch (typeName) {
      case "Optional":
        flags.required = false
        current = current.typeArguments?.[0] ?? current
        continue
      case "Unique":
        flags.unique = true
        current = current.typeArguments?.[0] ?? current
        continue
      case "Indexed":
        flags.index = true
        current = current.typeArguments?.[0] ?? current
        continue
      case "ServerDefault":
        flags.serverGenerated = true
        current = current.typeArguments?.[0] ?? current
        continue
      case "AutoIncrement":
        flags.serverGenerated = true
        flags.autoIncrement = true
        current = current.typeArguments?.[0] ?? current
        continue
      case "PrimaryKey":
        flags.primaryKey = true
        flags.required = true
        flags.unique = true
        current = current.typeArguments?.[0] ?? current
        continue
      case "Default":
        // Default<T, V> — unwrap to T so `Default<boolean, true>` resolves as boolean, not text.
        current = current.typeArguments?.[0] ?? current
        continue
      case "Searchable":
        current = current.typeArguments?.[0] ?? current
        continue
      case "EditorReadOnly":
        flags.editorReadOnly = true
        current = current.typeArguments?.[0] ?? current
        continue
      case "Computed":
        flags.editorReadOnly = true
        flags.serverGenerated = true
        current = current.typeArguments?.[0] ?? current
        continue
      case "ComputedFrom": {
        const valueArg = current.typeArguments?.[0]
        const sourcesArg = current.typeArguments?.[1]
        const parsed = parseComputedFromSecondArg(sourcesArg, sourceFile)
        if (parsed) {
          flags.computedFromSources = parsed.sources
          flags.computedFromTemplate = parsed.template
        } else {
          flags.computedFromSources = ["title"]
        }
        current = valueArg ?? current
        continue
      }
      case "MaxLength":
      case "MinLength":
      case "Between":
        current = current.typeArguments?.[0] ?? current
        continue
      case "RelatedTo":
        flags.relationCardinality = "one"
        flags.relationTarget = relationTargetFromTypeArg(current.typeArguments?.[0], sourceFile)
        // `target` must match `ModelAst.name` to satisfy validator resolution.
        // FK column follows the field name (two relations to the same model need distinct columns).
        return {
          kind: "relation",
          cardinality: "belongsTo",
          target: flags.relationTarget,
          foreignKey: relationForeignKeyFromField(fieldName),
          ...(flags.editorReadOnly && { readOnly: true }),
        }
      case "HasOne":
        flags.relationCardinality = "one"
        flags.relationTarget = current.typeArguments?.[0]?.getText(sourceFile).replace(/\W/g, "") ?? "unknown"
        return {
          kind: "relation",
          cardinality: "hasOne",
          target: flags.relationTarget,
          ...(flags.editorReadOnly && { readOnly: true }),
        }
      case "HasMany":
      case "ManyToMany":
        flags.relationCardinality = "many"
        flags.relationTarget = current.typeArguments?.[0]?.getText(sourceFile).replace(/\W/g, "") ?? "unknown"
        return {
          kind: "relation",
          cardinality: "hasMany",
          target: flags.relationTarget,
          ...(flags.editorReadOnly && { readOnly: true }),
        }
      default:
        break
    }
    break
  }

  const scalar = parseScalarType(current, sourceFile, blockAliases, bucketAliases, bucketsById)
  const parsed: FieldAst = {
    ...scalar,
    required: flags.required,
    unique: flags.unique,
    index: flags.index,
    ...(flags.primaryKey && { primaryKey: true }),
    ...(flags.editorReadOnly && { readOnly: true }),
  }

  if (flags.autoIncrement && parsed.kind === "integer") {
    parsed.kind = "serial"
    parsed.pgType = "SERIAL"
  }

  // RFC parity with existing examples: `id: UUID` should be the model PK unless
  // explicitly overridden via wrappers such as PrimaryKey<> in source types.
  if (
    fieldName === "id" &&
    parsed.kind === "uuid" &&
    flags.primaryKey === false
  ) {
    parsed.primaryKey = true
    parsed.unique = true
    parsed.required = true
  }

  // Align with engine fixtures: PK UUID is created by the database unless the author supplies one.
  if (parsed.primaryKey === true && parsed.kind === "uuid") {
    parsed.default = { kind: "genRandomUuid" }
  } else if (parsed.primaryKey === true && (parsed.kind === "serial" || parsed.kind === "bigSerial")) {
    flags.serverGenerated = true
  }

  if (flags.serverGenerated === true) {
    parsed.serverGenerated = true
  }

  // Convention: standard audit columns are filled by the DB on insert/update.
  const auditTs =
    fieldName === "created_at" ||
    fieldName === "updated_at" ||
    fieldName === "createdAt" ||
    fieldName === "updatedAt"
  if (auditTs) {
    parsed.serverGenerated = true
    if (
      (parsed.kind === "datetime" || parsed.kind === "date") &&
      parsed.default === undefined
    ) {
      parsed.default = { kind: "now" }
    }
  }

  // `ServerDefault<Date>` etc. → DEFAULT NOW() for column types Postgres handles with NOW().
  if (
    flags.serverGenerated &&
    (parsed.kind === "datetime" || parsed.kind === "date") &&
    parsed.default === undefined
  ) {
    parsed.default = { kind: "now" }
  }

  const hasCfTemplate = flags.computedFromTemplate !== undefined
  const hasCfSources = Boolean(flags.computedFromSources && flags.computedFromSources.length > 0)
  if (parsed.kind === "text" && (hasCfTemplate || hasCfSources)) {
    return {
      ...parsed,
      ...(hasCfSources && { sources: flags.computedFromSources! }),
      ...(hasCfTemplate && { template: flags.computedFromTemplate }),
    }
  }

  return parsed
}

function parseScalarType(
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
  blockAliases: Map<string, BlockDefinitionAst>,
  bucketAliases: Map<string, string>,
  bucketsById: Map<string, ExtractedStorageBucketAst>,
): FieldAst {
  if (ts.isArrayTypeNode(typeNode)) {
    const element = parseScalarType(typeNode.elementType, sourceFile, blockAliases, bucketAliases, bucketsById)
    const elementKind = typeof element.kind === "string" ? element.kind : "text"
    // Keep arrays as native SQL arrays (old `arrayOf(...)` parity), not JSONB.
    return {
      kind: "array",
      pgType: "ARRAY",
      elementType: elementKind,
    }
  }

  if (ts.isUnionTypeNode(typeNode)) {
    const literals = typeNode.types.filter(ts.isLiteralTypeNode)
    if (literals.length === typeNode.types.length && literals.every((lit) => ts.isStringLiteral(lit.literal))) {
      return {
        kind: "enum",
        pgType: "TEXT",
        values: literals.map((lit) => (lit.literal as ts.StringLiteral).text),
      }
    }
    const nonNull = typeNode.types.find((t) => t.kind !== ts.SyntaxKind.NullKeyword)
    if (nonNull) return parseScalarType(nonNull, sourceFile, blockAliases, bucketAliases, bucketsById)
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    const ref = typeNode.typeName.getText(sourceFile)
    switch (ref) {
      case "UUID":
      case "SupatypeAuthUserId":
        return { kind: "uuid", pgType: "UUID" }
      case "RichText":
        return { kind: "richText", pgType: "JSONB" }
      case "Slug": {
        const fromArg = typeNode.typeArguments?.[0]
        const fromLiteral = fromArg ? literalStringType(fromArg) : null
        const from = fromLiteral ?? "title"
        return { kind: "slug", pgType: "TEXT", from }
      }
      case "Email":
        return { kind: "email", pgType: "TEXT" }
      case "URL":
        return { kind: "url", pgType: "TEXT" }
      case "Markdown":
        return { kind: "text", pgType: "TEXT" }
      case "Color":
        return { kind: "color", pgType: "TEXT" }
      case "PhoneNumber":
        return { kind: "text", pgType: "TEXT" }
      case "IPAddress":
        return { kind: "ip", pgType: "TEXT" }
      case "CIDR":
        return { kind: "cidr", pgType: "TEXT" }
      case "MacAddress":
        return { kind: "macaddr", pgType: "TEXT" }
      case "XML":
        return { kind: "xml", pgType: "TEXT" }
      case "TSQuery":
        return { kind: "tsQuery", pgType: "TEXT" }
      case "TSVector":
        return { kind: "tsVector", pgType: "TEXT" }
      case "Money":
        return { kind: "money", pgType: "TEXT" }
      case "Decimal":
        return { kind: "decimal", pgType: "TEXT" }
      case "DateOnly":
        return { kind: "date", pgType: "DATE" }
      case "Date":
      case "DateTime":
      case "Timestamp":
        return { kind: "datetime", pgType: "TIMESTAMP WITH TIME ZONE" }
      case "Int":
        return { kind: "integer", pgType: "INTEGER" }
      case "SmallInt":
        return { kind: "smallInt", pgType: "SMALLINT" }
      case "BigInt":
        return { kind: "bigInt", pgType: "BIGINT" }
      case "Float":
        return { kind: "float", pgType: "DOUBLE PRECISION" }
      case "Bytea":
        return { kind: "bytes", pgType: "BYTEA" }
      case "JSON":
        return { kind: "json", pgType: "JSONB" }
      case "GeoPoint":
        return { kind: "geo", pgType: "GEOGRAPHY", geoType: "point", srid: 4326 }
      case "Geo":
        return { kind: "geo", pgType: "GEOGRAPHY", geoType: "point", srid: 4326 }
      case "Asset":
      case "FileAsset": {
        const bucket = resolveBucketName(typeNode.typeArguments?.[0], sourceFile, bucketAliases, "assets")
        return attachStorageFieldMeta({ kind: "file", pgType: "TEXT", bucket }, bucket, bucketsById)
      }
      case "ImageAsset": {
        const bucket = resolveBucketName(typeNode.typeArguments?.[0], sourceFile, bucketAliases, "images")
        return attachStorageFieldMeta({ kind: "image", pgType: "TEXT", bucket }, bucket, bucketsById)
      }
      case "Blocks":
        return {
          kind: "blocks",
          pgType: "JSONB",
          blocks: parseBlocksTypeDefinitions(
            typeNode.typeArguments?.[0],
            sourceFile,
            blockAliases,
            bucketAliases,
            bucketsById,
          ),
        }
      case "Vector": {
        const dimensions = typeNode.typeArguments?.[0]?.getText(sourceFile)
        return { kind: "vector", pgType: "VECTOR", dimensions: Number(dimensions ?? "1536") }
      }
      default:
        return { kind: "text", pgType: "TEXT" }
    }
  }

  switch (typeNode.kind) {
    case ts.SyntaxKind.StringKeyword:
      return { kind: "text", pgType: "TEXT" }
    case ts.SyntaxKind.NumberKeyword:
      return { kind: "float", pgType: "DOUBLE PRECISION" }
    case ts.SyntaxKind.BooleanKeyword:
      return { kind: "boolean", pgType: "BOOLEAN" }
    default:
      return { kind: "json", pgType: "JSONB" }
  }
}

function collectBlockAliases(
  sourceFile: ts.SourceFile,
  bucketAliases: Map<string, string>,
  bucketsById: Map<string, ExtractedStorageBucketAst>,
): Map<string, BlockDefinitionAst> {
  const blocks = new Map<string, BlockDefinitionAst>()
  for (const stmt of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(stmt)) continue
    if (!ts.isTypeReferenceNode(stmt.type)) continue
    if (!ts.isIdentifier(stmt.type.typeName) || stmt.type.typeName.text !== "Block") continue
    const block = parseInlineBlockDefinition(stmt.type, sourceFile, new Map(), bucketAliases, bucketsById)
    if (!block) continue
    blocks.set(stmt.name.text, block)
  }
  return blocks
}

function collectBucketContext(sourceFile: ts.SourceFile): {
  aliases: Map<string, string>
  bucketsById: Map<string, ExtractedStorageBucketAst>
} {
  const aliases = new Map<string, string>()
  const bucketsById = new Map<string, ExtractedStorageBucketAst>()

  for (const stmt of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(stmt)) continue
    if (!ts.isTypeReferenceNode(stmt.type)) continue
    if (!ts.isIdentifier(stmt.type.typeName) || stmt.type.typeName.text !== "Bucket") continue
    const [nameArg, configArg] = stmt.type.typeArguments ?? []
    if (!nameArg || !ts.isLiteralTypeNode(nameArg) || !ts.isStringLiteral(nameArg.literal)) continue
    const id = nameArg.literal.text
    aliases.set(stmt.name.text, id)

    const parsed =
      configArg && ts.isTypeLiteralNode(configArg)
        ? parseBucketTypeLiteral(configArg, sourceFile)
        : {}

    const next = buildExtractedBucketAst(id, parsed)
    const existing = bucketsById.get(id)
    if (existing !== undefined && !bucketsEqual(existing, next)) {
      throw new Error(
        `Conflicting Bucket<> declarations for id "${id}". Use a single export per bucket id.`,
      )
    }
    bucketsById.set(id, next)
  }

  return { aliases, bucketsById }
}

function buildExtractedBucketAst(
  id: string,
  parsed: Partial<ParsedBucketLiteral>,
): ExtractedStorageBucketAst {
  const mode = parsed.accessMode ?? "private"
  const pub = mode === "public"

  const row: ExtractedStorageBucketAst = {
    id,
    public: pub,
    accessMode: mode,
    ...(parsed.allowedMimeTypes !== undefined && parsed.allowedMimeTypes.length > 0
      ? { allowedMimeTypes: parsed.allowedMimeTypes }
      : {}),
    ...(parsed.fileSizeLimit !== undefined ? { fileSizeLimit: parsed.fileSizeLimit } : {}),
    ...(parsed.access !== undefined &&
      Object.keys(parsed.access).length > 0 && { access: parsed.access }),
    ...(parsed.s3BucketPolicy !== undefined ? { s3BucketPolicy: parsed.s3BucketPolicy } : {}),
  }
  return row
}

interface ParsedBucketLiteral {
  accessMode?: "public" | "private" | "custom"
  allowedMimeTypes?: string[]
  fileSizeLimit?: number
  access?: Record<string, unknown>
  s3BucketPolicy?: string
}

function parseBucketTypeLiteral(
  lit: ts.TypeLiteralNode,
  sourceFile: ts.SourceFile,
): Partial<ParsedBucketLiteral> {
  const out: Partial<ParsedBucketLiteral> = {}
  for (const member of lit.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue
    const key = getPropertyName(member.name)
    if (!key) continue

    if (key === "accessMode") {
      const mode = parseAccessModeLiteral(member.type, sourceFile)
      if (mode !== undefined) out.accessMode = mode
      continue
    }
    if (key === "maxSize") {
      const s = parseSizeStringLiteral(member.type, sourceFile)
      if (s !== undefined) {
        const bytes = parseDataSizeBytes(s)
        out.fileSizeLimit = bytes
      }
      continue
    }
    if (key === "accept") {
      const types = parseMimeAcceptList(member.type, sourceFile)
      if (types !== undefined) out.allowedMimeTypes = types
      continue
    }
    if (key === "access") {
      const acc = parsePartialBucketAccess(member.type, sourceFile)
      if (acc !== undefined && Object.keys(acc).length > 0) out.access = acc
      continue
    }
    if (key === "s3BucketPolicy") {
      const pol = parseJsonStringLiteral(member.type, sourceFile)
      if (pol !== undefined) out.s3BucketPolicy = pol
      continue
    }
  }
  return out
}

function parseAccessModeLiteral(
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
): "public" | "private" | "custom" | undefined {
  const text = stripQuotes(typeNode.getText(sourceFile))
  if (text === "public" || text === "private" || text === "custom") return text
  return undefined
}

function parseSizeStringLiteral(typeNode: ts.TypeNode, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isLiteralTypeNode(typeNode) && ts.isStringLiteral(typeNode.literal)) {
    return typeNode.literal.text
  }
  return stripQuotes(typeNode.getText(sourceFile)) || undefined
}

function parseJsonStringLiteral(typeNode: ts.TypeNode, sourceFile: ts.SourceFile): string | undefined {
  return parseSizeStringLiteral(typeNode, sourceFile)
}

function parseMimeAcceptList(typeNode: ts.TypeNode, sourceFile: ts.SourceFile): string[] | undefined {
  if (ts.isTypeOperatorNode(typeNode) && typeNode.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return parseMimeAcceptList(typeNode.type, sourceFile)
  }
  if (ts.isTupleTypeNode(typeNode)) {
    const values: string[] = []
    for (const el of typeNode.elements) {
      const node: ts.TypeNode = ts.isNamedTupleMember(el) ? el.type : el
      const s = literalStringType(node)
      if (!s) return undefined
      values.push(s)
    }
    return values.length > 0 ? values : undefined
  }
  if (ts.isUnionTypeNode(typeNode)) {
    const values: string[] = []
    for (const u of typeNode.types) {
      const s = literalStringType(u)
      if (!s) return undefined
      values.push(s)
    }
    return values.length > 0 ? values : undefined
  }
  return undefined
}

function parsePartialBucketAccess(
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
): Record<string, unknown> | undefined {
  if (!ts.isTypeLiteralNode(typeNode)) return undefined
  const access: Record<string, unknown> = {}
  for (const member of typeNode.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue
    const key = getPropertyName(member.name)
    if (key !== "read" && key !== "create" && key !== "delete") continue
    access[key] = parseAccessRule(member.type, sourceFile)
  }
  return access
}

/** Parse human-readable size from schema types, e.g. `50MB`. */
function parseDataSizeBytes(lit: string): number {
  const m = lit.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i)
  if (!m?.[1] || !m[2]) throw new Error(`Invalid maxSize literal: "${lit}". Use forms like "50MB", "100KB".`)
  const n = Number(m[1])
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid maxSize number in: "${lit}"`)
  const pow: Record<string, number> = {
    B: 0,
    KB: 10,
    MB: 20,
    GB: 30,
  }
  const unit = m[2].toUpperCase() as keyof typeof pow
  const exp = pow[unit]
  if (exp === undefined) throw new Error(`Unsupported maxSize unit in: "${lit}"`)
  return Math.round(n * Math.pow(2, exp))
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, "")
}

function bucketsEqual(a: ExtractedStorageBucketAst, b: ExtractedStorageBucketAst): boolean {
  return (
    a.public === b.public &&
    (a.accessMode ?? "private") === (b.accessMode ?? "private") &&
    JSON.stringify(a.access ?? null) === JSON.stringify(b.access ?? null) &&
    JSON.stringify(a.allowedMimeTypes ?? null) === JSON.stringify(b.allowedMimeTypes ?? null) &&
    (a.fileSizeLimit ?? null) === (b.fileSizeLimit ?? null) &&
    (a.s3BucketPolicy ?? null) === (b.s3BucketPolicy ?? null)
  )
}

function attachStorageFieldMeta(
  field: FieldAst,
  bucketId: string,
  bucketsById: Map<string, ExtractedStorageBucketAst>,
): FieldAst {
  const cfg = bucketsById.get(bucketId)
  if (cfg?.accessMode !== undefined) {
    return {
      ...field,
      ...(cfg.accessMode !== undefined && { accessMode: cfg.accessMode }),
    }
  }
  return field
}

function parseBlocksTypeDefinitions(
  blocksArg: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
  blockAliases: Map<string, BlockDefinitionAst>,
  bucketAliases: Map<string, string>,
  bucketsById: Map<string, ExtractedStorageBucketAst>,
): BlockDefinitionAst[] {
  if (!blocksArg) return []
  const parts = ts.isUnionTypeNode(blocksArg) ? blocksArg.types : [blocksArg]
  const out: BlockDefinitionAst[] = []
  for (const part of parts) {
    if (ts.isTypeReferenceNode(part) && ts.isIdentifier(part.typeName)) {
      if (part.typeName.text === "Block") {
        const inline = parseInlineBlockDefinition(part, sourceFile, blockAliases, bucketAliases, bucketsById)
        if (inline) out.push(inline)
        continue
      }
      const aliased = blockAliases.get(part.typeName.text)
      if (aliased) out.push(aliased)
    }
  }
  return out
}

function parseInlineBlockDefinition(
  ref: ts.TypeReferenceNode,
  sourceFile: ts.SourceFile,
  blockAliases: Map<string, BlockDefinitionAst>,
  bucketAliases: Map<string, string>,
  bucketsById: Map<string, ExtractedStorageBucketAst>,
): BlockDefinitionAst | null {
  const [nameArg, fieldsArg, metaArg] = ref.typeArguments ?? []
  const name = literalStringType(nameArg)
  if (!name || !fieldsArg || !ts.isTypeLiteralNode(fieldsArg)) return null

  const fields: Record<string, FieldAst> = {}
  for (const member of fieldsArg.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue
    const fieldName = getPropertyName(member.name)
    if (!fieldName) continue
    fields[fieldName] = parseFieldType(
      fieldName,
      member.type,
      sourceFile,
      blockAliases,
      bucketAliases,
      bucketsById,
    )
  }

  let label: string | undefined
  let icon: string | undefined
  if (metaArg && ts.isTypeLiteralNode(metaArg)) {
    for (const m of metaArg.members) {
      if (!ts.isPropertySignature(m) || !m.type) continue
      const key = getPropertyName(m.name)
      if (!key) continue
      const value = literalStringType(m.type)
      if (!value) continue
      if (key === "label") label = value
      if (key === "icon") icon = value
    }
  }

  return {
    name,
    ...(label !== undefined && { label }),
    ...(icon !== undefined && { icon }),
    fields,
  }
}

function literalStringType(typeNode: ts.TypeNode | undefined): string | null {
  if (!typeNode) return null
  if (ts.isLiteralTypeNode(typeNode) && ts.isStringLiteral(typeNode.literal)) return typeNode.literal.text
  return null
}

/** Field names referenced in `{name}` and `{truncate(name, n)}` (case-sensitive, same as model fields). */
function fieldNamesInComputedTemplate(template: string): string[] {
  const fields = new Set<string>()
  const reTrunc = /\{truncate\s*\(\s*([a-zA-Z_]\w*)\s*,\s*(\d+)\s*\)\}/gi
  let m: RegExpExecArray | null
  while ((m = reTrunc.exec(template)) !== null) {
    const ref = m[1]
    if (ref) fields.add(ref)
  }
  const reSimple = /\{([a-zA-Z_]\w*)\}/g
  while ((m = reSimple.exec(template)) !== null) {
    const ref = m[1]
    if (ref) fields.add(ref)
  }
  return [...fields]
}

function looksLikeComputedTemplateLiteral(lit: string): boolean {
  return /\{truncate\s*\(/i.test(lit) || /\{[a-zA-Z_]\w*\}/g.test(lit)
}

/** Resolves second type arg of `ComputedFrom<Value, Sources>` — tuple concat, single field, or template literal. */
function parseComputedFromSecondArg(
  sourcesArg: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
): { sources: string[]; template?: string } | null {
  if (!sourcesArg) return null
  const single = literalStringType(sourcesArg)
  if (single) {
    if (looksLikeComputedTemplateLiteral(single)) {
      return { sources: fieldNamesInComputedTemplate(single), template: single }
    }
    return { sources: [single] }
  }

  const elemsFromTupleType = (tuple: ts.TupleTypeNode): ts.TypeNode[] | null => {
    const nodes: ts.TypeNode[] = []
    for (const el of tuple.elements) {
      if (ts.isNamedTupleMember(el)) {
        if (!el.type) return null
        nodes.push(el.type)
        continue
      }
      nodes.push(el as ts.TypeNode)
    }
    return nodes
  }

  const tupleElems = (): ts.TypeNode[] | null => {
    if (ts.isTupleTypeNode(sourcesArg)) return elemsFromTupleType(sourcesArg)
    if (ts.isTypeOperatorNode(sourcesArg) && sourcesArg.operator === ts.SyntaxKind.ReadonlyKeyword) {
      const inner = sourcesArg.type
      if (inner && ts.isTupleTypeNode(inner)) return elemsFromTupleType(inner)
    }
    return null
  }

  const elems = tupleElems()
  if (!elems || elems.length === 0) return null
  const keys: string[] = []
  for (const node of elems) {
    const k = literalStringType(node)
    if (!k) return null
    keys.push(k)
  }
  return { sources: keys }
}

function resolveBucketName(
  typeArg: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
  bucketAliases: Map<string, string>,
  fallback: string,
): string {
  if (!typeArg) return fallback
  if (ts.isTypeReferenceNode(typeArg) && ts.isIdentifier(typeArg.typeName)) {
    return bucketAliases.get(typeArg.typeName.text) ?? typeArg.typeName.text
  }
  if (ts.isLiteralTypeNode(typeArg) && ts.isStringLiteral(typeArg.literal)) {
    return typeArg.literal.text
  }
  return typeArg.getText(sourceFile).replace(/^['"]|['"]$/g, "") || fallback
}

function parseModelAccess(metaArg: ts.TypeNode | undefined, sourceFile: ts.SourceFile): Record<string, unknown> {
  if (!metaArg || !ts.isTypeLiteralNode(metaArg)) return {}
  const accessProp = metaArg.members.find(
    (member) => ts.isPropertySignature(member) && getPropertyName(member.name) === "access",
  )
  if (!accessProp || !ts.isPropertySignature(accessProp) || !accessProp.type || !ts.isTypeLiteralNode(accessProp.type)) {
    return {}
  }

  const access: Record<string, unknown> = {}
  for (const member of accessProp.type.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue
    const key = getPropertyName(member.name)
    if (!key) continue
    access[key] = parseAccessRule(member.type, sourceFile)
  }
  return access
}

function parseAccessRule(typeNode: ts.TypeNode, sourceFile: ts.SourceFile): Record<string, unknown> {
  if (!ts.isTypeReferenceNode(typeNode)) return { type: "private" }
  const ref = typeNode.typeName.getText(sourceFile)
  switch (ref) {
    case "Public":
    case "BucketPublic":
      return { type: "public" }
    case "LoggedIn":
    case "BucketLoggedIn":
      return { type: "authenticated" }
    case "Private":
    case "BucketPrivate":
      return { type: "private" }
    case "BucketOwner":
      return { type: "owner", field: "owner_id" }
    case "Owner": {
      const args = typeNode.typeArguments ?? []
      const keyArg = args.length >= 2 ? args[1] : args[0]
      // Must match engine `AccessRule::Owner { field }` (see supatype-schema-engine parser/ast.rs).
      return { type: "owner", field: keyArg?.getText(sourceFile).replace(/['"]/g, "") ?? "user_id" }
    }
    case "OwnerFrom": {
      const relationArg = typeNode.typeArguments?.[0]
      const relationField = relationArg?.getText(sourceFile).replace(/['"]/g, "") ?? "owner"
      return { type: "owner", field: relationForeignKeyFromField(relationField) }
    }
    case "Role": {
      const roleArg = typeNode.typeArguments?.[0]
      return { type: "role", roles: [roleArg?.getText(sourceFile).replace(/['"]/g, "") ?? "admin"] }
    }
    case "BucketRole": {
      const roleArg = typeNode.typeArguments?.[0]
      return { type: "role", roles: [roleArg?.getText(sourceFile).replace(/['"]/g, "") ?? "admin"] }
    }
    default:
      return { type: "private" }
  }
}

function relationTargetFromTypeArg(typeArg: ts.TypeNode | undefined, sourceFile: ts.SourceFile): string {
  if (!typeArg) return "unknown"
  const raw = typeArg.getText(sourceFile).replace(/\s/g, "")
  if (raw === "SupatypeAuthUser") return "supatype:user"
  return raw.replace(/\W/g, "")
}

function toSnakeCase(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").replace(/^_/, "").toLowerCase()
}

function relationForeignKeyFromField(fieldName: string): string {
  const snake = fieldName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
  const base = snake.replace(/_id$/i, "")
  return `${base}_id`
}
