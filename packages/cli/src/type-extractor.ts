import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import ts from "typescript"
import {
  applyImportRename,
  createResolveContext,
  needsChecker,
  resolveTypeNode,
  tryResolveTypeReference,
  unknownTypeError,
  type ResolveContext,
} from "./type-resolver.js"

import {
  emitField,
  emitModel,
  emitSchema,
  defaultPgTypeForKind,
  scalar,
  type BlockDefinitionAst,
  type ExtractedSchemaAstV2,
  type ExtractedStorageBucketAst,
  type FieldAstV2,
  type ParsedField,
} from "./schema-ast-v2.js"

export type { ExtractedSchemaAstV2 as ExtractedSchemaAst, ExtractedStorageBucketAst } from "./schema-ast-v2.js"

interface FieldParseContext {
  autoLocalize?: boolean
}

export function extractSchemaAstFromTypes(
  schemaPath: string,
  cwd: string = process.cwd(),
): ExtractedSchemaAstV2 | null {
  const absPath = resolve(cwd, schemaPath)
  if (!existsSync(absPath)) {
    throw new Error(`Schema file not found: ${absPath}`)
  }

  const sourceFiles = loadSchemaSourceFiles(absPath)
  const resolveCtx = createResolveContext(sourceFiles)
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
    const next = collectBlockAliases(sourceFile, bucketAliases, bucketsById, resolveCtx)
    for (const [name, block] of next) {
      blockAliases.set(name, block)
    }
  }

  const models: ExtractedSchemaAstV2["models"] = []

  for (const sourceFile of sourceFiles) {
    for (const stmt of sourceFile.statements) {
      if (!ts.isTypeAliasDeclaration(stmt)) continue
      if (!hasExportModifier(stmt)) continue
      if (!ts.isTypeReferenceNode(stmt.type)) continue
      const modelTypeName = stmt.type.typeName.getText(sourceFile)
      if (modelTypeName !== "Model" && modelTypeName !== "LocalizedModel") continue
      const [fieldsArg, metaArg] = stmt.type.typeArguments ?? []
      if (!fieldsArg) continue
      const fieldsLiteral = unwrapModelFields(fieldsArg, sourceFile, resolveCtx)
      if (!fieldsLiteral) continue

      const metaHints = parseMetaLiteral(metaArg, sourceFile)
      const fieldContext: FieldParseContext = {
        autoLocalize: modelTypeName === "LocalizedModel" || metaHints.autoLocalize === true,
      }

      const fields: Record<string, FieldAstV2> = {}
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
          fieldContext,
          resolveCtx,
        )
      }

      const { tableName, access, options } = parseModelMeta(
        metaArg,
        sourceFile,
        stmt.name.text,
        fieldsArg,
        fields,
      )

      models.push(
        emitModel(stmt.name.text, fields, options, tableName, access),
      )
    }
  }

  if (models.length === 0) return null

  const storageBuckets =
    bucketsById.size > 0 ? [...bucketsById.values()].sort((a, b) => a.id.localeCompare(b.id)) : undefined

  let localeConfig: { locales: string[]; defaultLocale: string } | undefined
  for (const sourceFile of sourceFiles) {
    const found = collectLocaleConfig(sourceFile)
    if (!found) continue
    if (localeConfig !== undefined) {
      throw new Error(
        "Conflicting LocaleConfig declarations. Export at most one `localeConfig` type alias.",
      )
    }
    localeConfig = found
  }

  return emitSchema(models, {
    ...(storageBuckets !== undefined && storageBuckets.length > 0 && { storageBuckets }),
    ...(localeConfig !== undefined && {
      locales: localeConfig.locales,
      defaultLocale: localeConfig.defaultLocale,
    }),
  })
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
      let specifier: string | undefined
      if (ts.isExportDeclaration(stmt)) {
        if (!stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
        specifier = stmt.moduleSpecifier.text
      } else if (ts.isImportDeclaration(stmt)) {
        if (!stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
        specifier = stmt.moduleSpecifier.text
      } else {
        continue
      }
      if (!specifier.startsWith(".")) continue
      const nextPath = resolveTypeModulePath(baseDir, specifier)
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

function unwrapModelFields(
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
  resolveCtx: ResolveContext,
  depth = 0,
): ts.TypeLiteralNode | null {
  if (depth > 16) return null
  if (ts.isTypeLiteralNode(typeNode)) return typeNode

  if (needsChecker(typeNode)) {
    const resolved = resolveTypeNode(typeNode, sourceFile, resolveCtx)
    if (ts.isTypeLiteralNode(resolved)) return resolved
    return unwrapModelFields(resolved, sourceFile, resolveCtx, depth + 1)
  }

  if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return null

  const typeName = applyImportRename(typeNode.typeName.text, sourceFile, resolveCtx.renameMap)

  // Composite helpers in @supatype/types wrap the concrete field object.
  if (
    typeName === "WithTimestamps" ||
    typeName === "WithSoftDelete" ||
    typeName === "WithPublishable"
  ) {
    const inner = typeNode.typeArguments?.[0]
    if (!inner) return null
    return unwrapModelFields(inner, sourceFile, resolveCtx, depth + 1)
  }

  const expanded = tryResolveTypeReference(typeNode, sourceFile, resolveCtx)
  if (expanded) {
    if (ts.isTypeLiteralNode(expanded)) return expanded
    return unwrapModelFields(expanded, sourceFile, resolveCtx, depth + 1)
  }

  return null
}

/** Parse `Default<T, V>` second type argument into a JSON-serializable literal. */
function parseDefaultLiteral(
  node: ts.TypeNode,
  sourceFile: ts.SourceFile,
): string | number | boolean | null | undefined {
  if (ts.isLiteralTypeNode(node)) {
    const lit = node.literal
    if (ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit)) return lit.text
    if (ts.isNumericLiteral(lit)) return Number(lit.text)
    if (lit.kind === ts.SyntaxKind.TrueKeyword) return true
    if (lit.kind === ts.SyntaxKind.FalseKeyword) return false
    if (lit.kind === ts.SyntaxKind.NullKeyword) return null
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  // Negative numeric literals appear as PrefixUnaryExpression in some TS versions.
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const inner = parseDefaultLiteral(node.operand as unknown as ts.TypeNode, sourceFile)
    if (typeof inner === "number") return -inner
  }
  return undefined
}

function parseFieldType(
  fieldName: string,
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
  blockAliases: Map<string, BlockDefinitionAst>,
  bucketAliases: Map<string, string>,
  bucketsById: Map<string, ExtractedStorageBucketAst>,
  context: FieldParseContext = {},
  resolveCtx: ResolveContext,
): FieldAstV2 {
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
    computedFromSources: undefined as string[] | undefined,
    computedFromTemplate: undefined as string | undefined,
    fieldDefault: undefined as string | number | boolean | null | undefined,
    localized: false,
    notLocalized: false,
  }

  const resolving = new Set<string>()
  let current = typeNode
  while (ts.isTypeReferenceNode(current) && ts.isIdentifier(current.typeName)) {
    const typeName = applyImportRename(current.typeName.text, sourceFile, resolveCtx.renameMap)
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
      case "Default": {
        const valueArg = current.typeArguments?.[1]
        if (valueArg !== undefined) {
          const literal = parseDefaultLiteral(valueArg, sourceFile)
          if (literal !== undefined) {
            flags.fieldDefault = literal
          }
        }
        // Unwrap to T so `Default<boolean, true>` resolves as boolean, not text.
        current = current.typeArguments?.[0] ?? current
        continue
      }
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
      case "Localized":
        flags.localized = true
        current = current.typeArguments?.[0] ?? current
        continue
      case "NotLocalized":
        flags.notLocalized = true
        current = current.typeArguments?.[0] ?? current
        continue
      case "RelatedTo":
        flags.relationCardinality = "one"
        flags.relationTarget = relationTargetFromTypeArg(current.typeArguments?.[0], sourceFile)
        // `target` must match `ModelAst.name` to satisfy validator resolution.
        // FK column follows the field name (two relations to the same model need distinct columns).
        return emitField({
          kind: "relation",
          kernel: { cardinality: "belongsTo", target: flags.relationTarget! },
          db: { foreignKey: relationForeignKeyFromField(fieldName) },
          platform: flags.editorReadOnly ? { readOnly: true } : {},
        })
      case "HasOne":
        flags.relationCardinality = "one"
        flags.relationTarget = current.typeArguments?.[0]?.getText(sourceFile).replace(/\W/g, "") ?? "unknown"
        return emitField({
          kind: "relation",
          kernel: { cardinality: "hasOne", target: flags.relationTarget },
          db: {},
          platform: flags.editorReadOnly ? { readOnly: true } : {},
        })
      case "HasMany":
      case "ManyToMany":
        flags.relationCardinality = "many"
        flags.relationTarget = current.typeArguments?.[0]?.getText(sourceFile).replace(/\W/g, "") ?? "unknown"
        return emitField({
          kind: "relation",
          kernel: { cardinality: "hasMany", target: flags.relationTarget },
          db: {},
          platform: flags.editorReadOnly ? { readOnly: true } : {},
        })
      default: {
        const resolved = tryResolveTypeReference(current, sourceFile, resolveCtx, { fieldName, resolving })
        if (resolved) {
          current = resolved
          continue
        }
        break
      }
    }
    break
  }

  const scalarBase = parseScalarType(
    current,
    sourceFile,
    blockAliases,
    bucketAliases,
    bucketsById,
    context,
    resolveCtx,
    fieldName,
    resolving,
  )

  let parsed: ParsedField = {
    kind: scalarBase.kind,
    kernel: {
      ...scalarBase.kernel,
      required: flags.required,
      ...(flags.primaryKey && { primaryKey: true }),
    },
    db: {
      ...scalarBase.db,
      unique: flags.unique,
      index: flags.index,
    },
    platform: {
      ...scalarBase.platform,
      ...(flags.editorReadOnly && { readOnly: true }),
    },
  }

  if (flags.autoIncrement && parsed.kind === "integer") {
    parsed = { ...parsed, kind: "serial", db: { ...parsed.db, pgType: "SERIAL" } }
  }

  if (fieldName === "id" && parsed.kind === "uuid" && flags.primaryKey === false) {
    parsed = {
      ...parsed,
      kernel: { ...parsed.kernel, primaryKey: true, required: true },
      db: { ...parsed.db, unique: true },
    }
  }

  if (flags.fieldDefault !== undefined) {
    if (parsed.kernel.default !== undefined) {
      throw new Error(
        `Field "${fieldName}": use either Default<…> or an inline type default (e.g. RichText<"…">), not both.`,
      )
    }
    parsed = {
      ...parsed,
      kernel: { ...parsed.kernel, default: { kind: "value", value: flags.fieldDefault } },
    }
  }

  if (parsed.kernel.primaryKey === true && parsed.kind === "uuid" && parsed.kernel.default === undefined) {
    parsed = {
      ...parsed,
      kernel: { ...parsed.kernel, default: { kind: "genRandomUuid" } },
    }
  } else if (
    parsed.kernel.primaryKey === true &&
    (parsed.kind === "serial" || parsed.kind === "bigSerial")
  ) {
    flags.serverGenerated = true
  }

  if (flags.serverGenerated === true) {
    parsed = { ...parsed, db: { ...parsed.db, serverGenerated: true } }
  }

  const auditTs =
    fieldName === "created_at" ||
    fieldName === "updated_at" ||
    fieldName === "createdAt" ||
    fieldName === "updatedAt"
  if (auditTs) {
    parsed = { ...parsed, db: { ...parsed.db, serverGenerated: true } }
    if (
      (parsed.kind === "datetime" || parsed.kind === "date") &&
      parsed.kernel.default === undefined
    ) {
      parsed = { ...parsed, kernel: { ...parsed.kernel, default: { kind: "now" } } }
    }
  }

  if (
    flags.serverGenerated &&
    (parsed.kind === "datetime" || parsed.kind === "date") &&
    parsed.kernel.default === undefined
  ) {
    parsed = { ...parsed, kernel: { ...parsed.kernel, default: { kind: "now" } } }
  }

  const hasCfTemplate = flags.computedFromTemplate !== undefined
  const hasCfSources = Boolean(flags.computedFromSources && flags.computedFromSources.length > 0)
  if (parsed.kind === "text" && (hasCfTemplate || hasCfSources)) {
    const kernel: ParsedField["kernel"] = { ...parsed.kernel }
    if (hasCfSources && flags.computedFromSources) {
      kernel.sources = flags.computedFromSources
    }
    if (hasCfTemplate && flags.computedFromTemplate !== undefined) {
      kernel.template = flags.computedFromTemplate
    }
    parsed = { ...parsed, kernel }
  }

  return emitField(finalizeParsedField(parsed, flags, context))
}

function finalizeParsedField(
  parsed: ParsedField,
  flags: { localized: boolean; notLocalized: boolean },
  context: FieldParseContext,
): ParsedField {
  let localized = flags.localized

  if (
    !localized &&
    !flags.notLocalized &&
    context.autoLocalize &&
    shouldAutoLocalizeFieldKind(parsed.kind)
  ) {
    localized = true
  }

  if (parsed.kind === "blocks" && parsed.kernel.blocks && context.autoLocalize && !localized) {
    return {
      ...parsed,
      kernel: {
        ...parsed.kernel,
        blocks: parsed.kernel.blocks.map((blockDef) => ({
          ...blockDef,
          fields: Object.fromEntries(
            Object.entries(blockDef.fields).map(([name, fieldWire]) => [
              name,
              localizeFieldWire(fieldWire),
            ]),
          ),
        })),
      },
    }
  }

  if (localized) {
    return {
      ...parsed,
      kernel: { ...parsed.kernel, localized: true },
      db: { ...parsed.db, pgType: "JSONB" },
    }
  }
  return parsed
}

function shouldAutoLocalizeFieldKind(kind: unknown): boolean {
  return kind === "text" || kind === "richText"
}

function localizeFieldWire(field: FieldAstV2): FieldAstV2 {
  if (field.localized === true) return field
  if (!shouldAutoLocalizeFieldKind(field.kind)) return field
  const annotations = (field.annotations ?? {}) as { db?: Record<string, unknown>; platform?: Record<string, unknown> }
  return {
    ...field,
    localized: true,
    annotations: {
      ...annotations,
      db: { ...annotations.db, pgType: "JSONB" },
    },
  }
}

function parseScalarType(
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
  blockAliases: Map<string, BlockDefinitionAst>,
  bucketAliases: Map<string, string>,
  bucketsById: Map<string, ExtractedStorageBucketAst>,
  context: FieldParseContext = {},
  resolveCtx: ResolveContext,
  fieldName = "?",
  resolving: Set<string> = new Set(),
): ParsedField {
  if (ts.isArrayTypeNode(typeNode)) {
    const element = parseScalarType(
      typeNode.elementType,
      sourceFile,
      blockAliases,
      bucketAliases,
      bucketsById,
      context,
      resolveCtx,
      fieldName,
      resolving,
    )
    return scalar("array", {
      db: { elementType: defaultPgTypeForKind(element.kind) },
    })
  }

  if (ts.isUnionTypeNode(typeNode)) {
    const literals = typeNode.types.filter(ts.isLiteralTypeNode)
    if (literals.length === typeNode.types.length && literals.every((lit) => ts.isStringLiteral(lit.literal))) {
      return scalar("enum", {
        kernel: {
          values: literals.map((lit) => (lit.literal as ts.StringLiteral).text),
        },
      })
    }
    const nonNull = typeNode.types.find((t) => t.kind !== ts.SyntaxKind.NullKeyword)
    if (nonNull) {
      return parseScalarType(
        nonNull,
        sourceFile,
        blockAliases,
        bucketAliases,
        bucketsById,
        context,
        resolveCtx,
        fieldName,
        resolving,
      )
    }
  }

  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const resolved = tryResolveTypeReference(typeNode, sourceFile, resolveCtx, { fieldName, resolving })
    if (resolved) {
      return parseScalarType(
        resolved,
        sourceFile,
        blockAliases,
        bucketAliases,
        bucketsById,
        context,
        resolveCtx,
        fieldName,
        resolving,
      )
    }
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    const ref = ts.isIdentifier(typeNode.typeName)
      ? applyImportRename(typeNode.typeName.text, sourceFile, resolveCtx.renameMap)
      : typeNode.typeName.getText(sourceFile)
    switch (ref) {
      case "UUID":
      case "SupatypeAuthUserId":
        return scalar("uuid")
      case "RichText": {
        const defaultArg = typeNode.typeArguments?.[0]
        if (!defaultArg) return scalar("richText")
        const literal = parseDefaultLiteral(defaultArg, sourceFile)
        if (literal === undefined) {
          throw new Error(
            `RichText default must be a string literal (plain text or Lexical JSON string), not HTML.`,
          )
        }
        if (typeof literal !== "string") {
          throw new Error(
            `RichText<…> default must be a string literal (plain text or Lexical JSON string).`,
          )
        }
        return scalar("richText", {
          kernel: { default: { kind: "value", value: literal } },
        })
      }
      case "Slug": {
        const fromArg = typeNode.typeArguments?.[0]
        const fromLiteral = fromArg ? literalStringType(fromArg) : null
        return scalar("slug", { kernel: { from: fromLiteral ?? "title" } })
      }
      case "Email":
        return scalar("email")
      case "URL":
        return scalar("url")
      case "Markdown":
      case "PhoneNumber":
        return scalar("text")
      case "Color":
        return scalar("color")
      case "IPAddress":
        return scalar("ip")
      case "CIDR":
        return scalar("cidr")
      case "MacAddress":
        return scalar("macaddr")
      case "XML":
        return scalar("xml")
      case "TSQuery":
        return scalar("tsQuery")
      case "TSVector":
        return scalar("tsVector")
      case "Money":
        return scalar("money")
      case "Decimal":
        return scalar("decimal")
      case "DateOnly":
        return scalar("date")
      case "Date":
      case "DateTime":
      case "Timestamp":
        return scalar("datetime", { db: { pgType: "TIMESTAMP WITH TIME ZONE" } })
      case "Int":
        return scalar("integer")
      case "SmallInt":
        return scalar("smallInt")
      case "BigInt":
        return scalar("bigInt")
      case "Float":
        return scalar("float")
      case "Bytea":
        return scalar("bytes")
      case "JSON":
        return scalar("json")
      case "Button":
        return scalar("button", { db: { pgType: "JSONB" } })
      case "Duration":
        return scalar("json", { db: { pgType: "JSONB" } })
      case "GeoPoint":
      case "Geo":
        return scalar("geo", { kernel: { geoType: "point", srid: 4326 } })
      case "Asset":
      case "FileAsset": {
        const bucket = resolveBucketName(typeNode.typeArguments?.[0], sourceFile, bucketAliases, "assets")
        const assetOpts = parseAssetFieldOptions(typeNode.typeArguments?.[1], sourceFile)
        return attachStorageFieldMeta(
          scalar("file", {
            db: { pgType: "TEXT" },
            kernel: { bucket, ...(assetOpts.localized && { localized: true }) },
          }),
          bucket,
          bucketsById,
        )
      }
      case "ImageAsset": {
        const bucket = resolveBucketName(typeNode.typeArguments?.[0], sourceFile, bucketAliases, "images")
        const assetOpts = parseAssetFieldOptions(typeNode.typeArguments?.[1], sourceFile)
        return attachStorageFieldMeta(
          scalar("image", {
            db: { pgType: "TEXT" },
            kernel: { bucket, ...(assetOpts.localized && { localized: true }) },
          }),
          bucket,
          bucketsById,
        )
      }
      case "Blocks":
        return scalar("blocks", {
          kernel: {
            index: true,
            blocks: parseBlocksTypeDefinitions(
              typeNode.typeArguments?.[0],
              sourceFile,
              blockAliases,
              bucketAliases,
              bucketsById,
              context,
              resolveCtx,
            ),
          },
        })
      case "Vector": {
        const dimensions = typeNode.typeArguments?.[0]?.getText(sourceFile)
        return scalar("vector", {
          kernel: { dimensions: Number(dimensions ?? "1536") },
        })
      }
      default:
        throw unknownTypeError(ref, fieldName)
    }
  }

  switch (typeNode.kind) {
    case ts.SyntaxKind.StringKeyword:
      return scalar("text")
    case ts.SyntaxKind.NumberKeyword:
      return scalar("float")
    case ts.SyntaxKind.BooleanKeyword:
      return scalar("boolean")
    default:
      return scalar("json")
  }
}

function collectBlockAliases(
  sourceFile: ts.SourceFile,
  bucketAliases: Map<string, string>,
  bucketsById: Map<string, ExtractedStorageBucketAst>,
  resolveCtx: ResolveContext,
): Map<string, BlockDefinitionAst> {
  const blocks = new Map<string, BlockDefinitionAst>()
  for (const stmt of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(stmt)) continue
    if (!ts.isTypeReferenceNode(stmt.type)) continue
    if (!ts.isIdentifier(stmt.type.typeName) || stmt.type.typeName.text !== "Block") continue
    const block = parseInlineBlockDefinition(
      stmt.type,
      sourceFile,
      new Map(),
      bucketAliases,
      bucketsById,
      {},
      resolveCtx,
    )
    if (!block) continue
    blocks.set(stmt.name.text, block)
  }
  return blocks
}

function collectLocaleConfig(
  sourceFile: ts.SourceFile,
): { locales: string[]; defaultLocale: string } | undefined {
  for (const stmt of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(stmt)) continue
    if (!hasExportModifier(stmt)) continue
    if (!ts.isTypeReferenceNode(stmt.type)) continue
    if (stmt.type.typeName.getText(sourceFile) !== "LocaleConfig") continue
    const parsed = parseLocaleConfigTypeRef(stmt.type, sourceFile)
    if (parsed) return parsed
  }
  return undefined
}

function parseLocaleConfigTypeRef(
  typeRef: ts.TypeReferenceNode,
  sourceFile: ts.SourceFile,
): { locales: string[]; defaultLocale: string } | null {
  const [localesArg, defaultArg] = typeRef.typeArguments ?? []
  if (!localesArg || !defaultArg) return null

  const locales = parseStringLiteralTuple(localesArg, sourceFile)
  const defaultLocale = literalStringType(defaultArg)
  if (!locales || locales.length === 0 || !defaultLocale) return null
  if (!locales.includes(defaultLocale)) {
    throw new Error(
      `LocaleConfig defaultLocale "${defaultLocale}" must be one of: ${locales.join(", ")}`,
    )
  }
  return { locales, defaultLocale }
}

function parseStringLiteralTuple(node: ts.TypeNode, sourceFile: ts.SourceFile): string[] | null {
  if (!ts.isTupleTypeNode(node)) return null
  const out: string[] = []
  for (const el of node.elements) {
    const lit = literalStringType(el)
    if (!lit) return null
    out.push(lit)
  }
  return out
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
  field: ParsedField,
  bucketId: string,
  bucketsById: Map<string, ExtractedStorageBucketAst>,
): ParsedField {
  const cfg = bucketsById.get(bucketId)
  if (cfg?.accessMode !== undefined) {
    return {
      ...field,
      kernel: { ...field.kernel, accessMode: cfg.accessMode },
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
  context: FieldParseContext = {},
  resolveCtx: ResolveContext,
): BlockDefinitionAst[] {
  if (!blocksArg) return []
  const parts = ts.isUnionTypeNode(blocksArg) ? blocksArg.types : [blocksArg]
  const out: BlockDefinitionAst[] = []
  for (const part of parts) {
    if (ts.isTypeReferenceNode(part) && ts.isIdentifier(part.typeName)) {
      if (part.typeName.text === "Block") {
        const inline = parseInlineBlockDefinition(
          part,
          sourceFile,
          blockAliases,
          bucketAliases,
          bucketsById,
          context,
          resolveCtx,
        )
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
  context: FieldParseContext = {},
  resolveCtx: ResolveContext,
): BlockDefinitionAst | null {
  const [nameArg, fieldsArg, metaArg] = ref.typeArguments ?? []
  const name = literalStringType(nameArg)
  if (!name || !fieldsArg || !ts.isTypeLiteralNode(fieldsArg)) return null

  const fields: Record<string, FieldAstV2> = {}
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
      context,
      resolveCtx,
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

function isBooleanLiteralType(typeNode: ts.TypeNode, value: boolean): boolean {
  if (value) {
    if (typeNode.kind === ts.SyntaxKind.TrueKeyword) return true
    if (ts.isLiteralTypeNode(typeNode) && typeNode.literal.kind === ts.SyntaxKind.TrueKeyword) {
      return true
    }
    return false
  }
  if (typeNode.kind === ts.SyntaxKind.FalseKeyword) return true
  if (ts.isLiteralTypeNode(typeNode) && typeNode.literal.kind === ts.SyntaxKind.FalseKeyword) {
    return true
  }
  return false
}

function parseAssetFieldOptions(
  optionsArg: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
): { localized: boolean } {
  if (!optionsArg || !ts.isTypeLiteralNode(optionsArg)) return { localized: false }
  for (const member of optionsArg.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue
    const key = getPropertyName(member.name)
    if (key === "localized" && isBooleanLiteralType(member.type, true)) {
      return { localized: true }
    }
  }
  return { localized: false }
}

function parseMetaLiteral(
  metaArg: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
): {
  tableName?: string
  singleton?: boolean
  timestamps?: boolean
  softDelete?: boolean
  autoLocalize?: boolean
} {
  const result: {
    tableName?: string
    singleton?: boolean
    timestamps?: boolean
    softDelete?: boolean
    autoLocalize?: boolean
  } = {}

  if (!metaArg || !ts.isTypeLiteralNode(metaArg)) return result

  for (const member of metaArg.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue
    const key = getPropertyName(member.name)
    if (!key) continue

    if (key === "singleton" && isBooleanLiteralType(member.type, true)) {
      result.singleton = true
    } else if (key === "timestamps") {
      if (isBooleanLiteralType(member.type, true)) result.timestamps = true
      if (isBooleanLiteralType(member.type, false)) result.timestamps = false
    } else if (key === "softDelete") {
      if (isBooleanLiteralType(member.type, true)) result.softDelete = true
      if (isBooleanLiteralType(member.type, false)) result.softDelete = false
    } else if (key === "autoLocalize" && isBooleanLiteralType(member.type, true)) {
      result.autoLocalize = true
    } else if (
      key === "tableName" &&
      ts.isLiteralTypeNode(member.type) &&
      ts.isStringLiteral(member.type.literal)
    ) {
      result.tableName = member.type.literal.text
    }
  }

  return result
}

function hasCompositeWrapper(typeNode: ts.TypeNode, wrapperName: string): boolean {
  if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return false
  if (typeNode.typeName.text === wrapperName) return true
  if (
    typeNode.typeName.text === "WithTimestamps" ||
    typeNode.typeName.text === "WithSoftDelete" ||
    typeNode.typeName.text === "WithPublishable"
  ) {
    const inner = typeNode.typeArguments?.[0]
    if (inner) return hasCompositeWrapper(inner, wrapperName)
  }
  return false
}

function parseModelMeta(
  metaArg: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
  modelName: string,
  fieldsArg: ts.TypeNode,
  fields: Record<string, FieldAstV2>,
): { tableName: string; access: Record<string, unknown>; options: Record<string, unknown> } {
  const literal = parseMetaLiteral(metaArg, sourceFile)
  const singleton = literal.singleton === true
  const tableName =
    literal.tableName ?? (singleton ? `_global_${toSnakeCase(modelName)}` : toSnakeCase(modelName))

  const timestamps =
    literal.timestamps ??
    (hasCompositeWrapper(fieldsArg, "WithTimestamps") ||
      (fields["created_at"] !== undefined && fields["updated_at"] !== undefined))

  const softDelete =
    literal.softDelete ??
    (hasCompositeWrapper(fieldsArg, "WithSoftDelete") || fields["deleted_at"] !== undefined)

  const options: Record<string, unknown> = {}
  if (singleton) options.singleton = true
  if (timestamps) options.timestamps = true
  if (softDelete) options.softDelete = true
  if (literal.autoLocalize === true) options.autoLocalize = true

  return {
    tableName,
    access: parseModelAccess(metaArg, sourceFile),
    options,
  }
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
      return { type: "owner", field: relationField }
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
