import { resolve } from "node:path"
import ts from "typescript"

export type AliasEntry = {
  typeParams: string[]
  body: ts.TypeNode
  sourceFile: ts.SourceFile
}

/** fileName → (localName → canonicalName) for explicit `import { X as Y }` renames. */
export type ImportRenameMap = Map<string, Map<string, string>>

export type CheckerContext = {
  program: ts.Program
  checker: ts.TypeChecker
}

export type ResolveContext = {
  aliasRegistry: Map<string, AliasEntry>
  renameMap: ImportRenameMap
  sourceFiles: ts.SourceFile[]
  getChecker: () => CheckerContext
}

const MODEL_ALIAS_NAMES = new Set(["Model", "LocalizedModel"])

export function createResolveContext(sourceFiles: ts.SourceFile[]): ResolveContext {
  let checkerCtx: CheckerContext | undefined
  return {
    aliasRegistry: buildAliasRegistry(sourceFiles),
    renameMap: buildImportRenameMap(sourceFiles),
    sourceFiles,
    getChecker: () => {
      if (!checkerCtx) {
        checkerCtx = createCheckerContext(sourceFiles)
      }
      return checkerCtx
    },
  }
}

export function buildAliasRegistry(sourceFiles: ts.SourceFile[]): Map<string, AliasEntry> {
  const registry = new Map<string, AliasEntry>()
  for (const sourceFile of sourceFiles) {
    for (const stmt of sourceFile.statements) {
      if (!ts.isTypeAliasDeclaration(stmt)) continue
      if (ts.isTypeReferenceNode(stmt.type) && ts.isIdentifier(stmt.type.typeName)) {
        if (MODEL_ALIAS_NAMES.has(stmt.type.typeName.text)) continue
      }
      const typeParams = stmt.typeParameters?.map((p) => p.name.text) ?? []
      registry.set(stmt.name.text, {
        typeParams,
        body: stmt.type,
        sourceFile,
      })
    }
  }
  return registry
}

export function buildImportRenameMap(sourceFiles: ts.SourceFile[]): ImportRenameMap {
  const renameMap: ImportRenameMap = new Map()
  for (const sourceFile of sourceFiles) {
    const fileRenames = new Map<string, string>()
    for (const stmt of sourceFile.statements) {
      if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue
      const bindings = stmt.importClause.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      for (const el of bindings.elements) {
        const localName = el.name.text
        const canonicalName = el.propertyName?.text ?? localName
        if (localName !== canonicalName) {
          fileRenames.set(localName, canonicalName)
        }
      }
    }
    if (fileRenames.size > 0) {
      renameMap.set(sourceFile.fileName, fileRenames)
    }
  }
  return renameMap
}

export function applyImportRename(
  name: string,
  sourceFile: ts.SourceFile,
  renameMap: ImportRenameMap,
): string {
  return renameMap.get(sourceFile.fileName)?.get(name) ?? name
}

export function needsChecker(node: ts.TypeNode): boolean {
  return containsConditionalOrMapped(node)
}

export function resolveTypeNode(
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
  ctx: ResolveContext,
  options: { fieldName?: string; resolving?: Set<string> } = {},
): ts.TypeNode {
  if (needsChecker(typeNode)) {
    return resolveViaChecker(typeNode, sourceFile, ctx, options.fieldName)
  }

  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const renamed = applyImportRename(typeNode.typeName.text, sourceFile, ctx.renameMap)
    if (renamed !== typeNode.typeName.text) {
      return resolveTypeNode(
        ts.factory.createTypeReferenceNode(renamed, typeNode.typeArguments),
        sourceFile,
        ctx,
        options,
      )
    }
    const expanded = tryExpandAlias(typeNode, sourceFile, ctx, options)
    if (expanded) {
      return resolveTypeNode(expanded, sourceFile, ctx, options)
    }
  }

  return typeNode
}

export function tryResolveTypeReference(
  typeNode: ts.TypeReferenceNode,
  sourceFile: ts.SourceFile,
  ctx: ResolveContext,
  options: { fieldName?: string; resolving?: Set<string> } = {},
): ts.TypeNode | null {
  if (!ts.isIdentifier(typeNode.typeName)) return null

  const renamed = applyImportRename(typeNode.typeName.text, sourceFile, ctx.renameMap)
  if (renamed !== typeNode.typeName.text) {
    return ts.factory.createTypeReferenceNode(renamed, typeNode.typeArguments)
  }

  return tryExpandAlias(typeNode, sourceFile, ctx, options)
}

function tryExpandAlias(
  typeNode: ts.TypeReferenceNode,
  sourceFile: ts.SourceFile,
  ctx: ResolveContext,
  options: { fieldName?: string; resolving?: Set<string> },
): ts.TypeNode | null {
  if (!ts.isIdentifier(typeNode.typeName)) return null
  const aliasName = applyImportRename(typeNode.typeName.text, sourceFile, ctx.renameMap)
  const entry = ctx.aliasRegistry.get(aliasName)
  if (!entry) return null

  const resolving = options.resolving ?? new Set<string>()
  if (resolving.has(aliasName)) {
    throw new Error(
      `Field "${options.fieldName ?? "?"}": circular alias chain detected resolving "${aliasName}".`,
    )
  }

  resolving.add(aliasName)

  const typeArgs = typeNode.typeArguments ?? []
  const synthetic =
    tryEvaluateConditionalAlias(entry, typeArgs) ?? tryEvaluateMappedOptionalFields(entry, typeArgs)
  if (synthetic) {
    return expandAliasChain(synthetic, sourceFile, ctx, options, resolving)
  }

  let expanded: ts.TypeNode
  if (needsChecker(entry.body)) {
    expanded = resolveViaChecker(typeNode, sourceFile, ctx, options.fieldName)
  } else {
    expanded = substituteAndParse(entry, typeArgs)
    if (needsChecker(expanded)) {
      expanded = resolveViaChecker(typeNode, sourceFile, ctx, options.fieldName)
    }
  }

  return expandAliasChain(expanded, sourceFile, ctx, options, resolving)
}

function expandAliasChain(
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
  ctx: ResolveContext,
  options: { fieldName?: string; resolving?: Set<string> },
  resolving: Set<string>,
): ts.TypeNode {
  if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
    return typeNode
  }

  const chainName = applyImportRename(typeNode.typeName.text, sourceFile, ctx.renameMap)
  if (!ctx.aliasRegistry.has(chainName) || resolving.has(chainName)) {
    return typeNode
  }

  const entry = ctx.aliasRegistry.get(chainName)!
  resolving.add(chainName)

  const typeArgs = typeNode.typeArguments ?? []
  const synthetic =
    tryEvaluateConditionalAlias(entry, typeArgs) ?? tryEvaluateMappedOptionalFields(entry, typeArgs)
  if (synthetic) {
    return expandAliasChain(synthetic, sourceFile, ctx, options, resolving)
  }

  let expanded: ts.TypeNode
  if (needsChecker(entry.body)) {
    expanded = resolveViaChecker(typeNode, sourceFile, ctx, options.fieldName)
  } else {
    expanded = substituteAndParse(entry, typeArgs)
    if (needsChecker(expanded)) {
      expanded = resolveViaChecker(typeNode, sourceFile, ctx, options.fieldName)
    }
  }

  return expandAliasChain(expanded, sourceFile, ctx, options, resolving)
}

function substituteAndParse(
  entry: AliasEntry,
  typeArgs: readonly ts.TypeNode[],
): ts.TypeNode {
  let text = entry.body.getText(entry.sourceFile)
  for (let i = 0; i < entry.typeParams.length; i++) {
    const param = entry.typeParams[i]
    const arg = typeArgs[i]
    if (!param || !arg) continue
    const argSource = arg.getSourceFile()
    const argText = arg.getText(argSource)
    text = text.replace(new RegExp(`\\b${escapeRegExp(param)}\\b`, "g"), argText)
  }
  const parsed = ts.createSourceFile(
    "__alias__.ts",
    `type __A__ = ${text}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const decl = parsed.statements[0]
  if (!decl || !ts.isTypeAliasDeclaration(decl)) {
    throw new Error("Internal error: failed to parse substituted type alias body.")
  }
  return decl.type
}

function resolveViaChecker(
  node: ts.TypeNode,
  sourceFile: ts.SourceFile,
  ctx: ResolveContext,
  fieldName?: string,
): ts.TypeNode {
  const { program, checker } = ctx.getChecker()
  const nodeFileName = resolve(node.getSourceFile().fileName)
  const programSf = program.getSourceFile(nodeFileName) ?? program.getSourceFile(resolve(sourceFile.fileName))
  if (!programSf) {
    throw checkerResolutionError(fieldName)
  }

  const programNode = findNodeAtPosition(programSf, node.pos, node.end) ?? node

  const type = checker.getTypeAtLocation(programNode)
  let typeText = checker.typeToString(
    type,
    programNode,
    ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
  )
  if (!typeText.trim()) {
    throw checkerResolutionError(fieldName)
  }

  let parsed = parseResolvedTypeText(typeText)
  if (needsChecker(parsed)) {
    typeText = checker.typeToString(type, programNode)
    parsed = parseResolvedTypeText(typeText)
  }
  if (needsChecker(parsed)) {
    throw checkerResolutionError(fieldName)
  }
  return parsed
}

function parseResolvedTypeText(typeText: string): ts.TypeNode {
  const parsed = ts.createSourceFile(
    "__resolved__.ts",
    `type __R__ = ${typeText}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const decl = parsed.statements[0]
  if (!decl || !ts.isTypeAliasDeclaration(decl)) {
    throw new Error("Internal error: failed to parse checker output.")
  }
  return decl.type
}

/** `T extends string ? Optional<T> : T` and similar — pick the Optional branch for scalar args. */
function tryEvaluateConditionalAlias(entry: AliasEntry, typeArgs: readonly ts.TypeNode[]): ts.TypeNode | null {
  const substituted = substituteAndParse(entry, typeArgs)
  if (!ts.isConditionalTypeNode(substituted)) return null
  if (substituted.extendsType.getText() !== "string") return null
  const trueType = substituted.trueType
  if (
    ts.isTypeReferenceNode(trueType) &&
    ts.isIdentifier(trueType.typeName) &&
    trueType.typeName.text === "Optional"
  ) {
    return trueType
  }
  return null
}

/** `{ [K in keyof T]: Optional<T[K]> }` with a concrete `T` type literal. */
function tryEvaluateMappedOptionalFields(entry: AliasEntry, typeArgs: readonly ts.TypeNode[]): ts.TypeNode | null {
  if (!ts.isMappedTypeNode(entry.body)) return null
  const template = entry.body.type
  if (
    template === undefined ||
    !ts.isTypeReferenceNode(template) ||
    template.typeName.getText() !== "Optional"
  ) {
    return null
  }

  const arg = typeArgs[0]
  if (!arg || !ts.isTypeLiteralNode(arg)) return null

  const argSource = arg.getSourceFile()
  const parts: string[] = []
  for (const member of arg.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue
    const name = member.name.getText(argSource)
    const typeText = member.type.getText(argSource)
    parts.push(`${name}: Optional<${typeText}>`)
  }
  if (parts.length === 0) return null

  const parsed = ts.createSourceFile(
    "__mapped__.ts",
    `type __M__ = { ${parts.join("; ")} }`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const decl = parsed.statements[0]
  if (!decl || !ts.isTypeAliasDeclaration(decl) || !ts.isTypeLiteralNode(decl.type)) return null
  return decl.type
}

function checkerResolutionError(fieldName?: string): Error {
  const prefix = fieldName ? `Field "${fieldName}": ` : ""
  return new Error(`${prefix}could not resolve conditional/mapped type via type checker.`)
}

const SUPATYPE_CHECKER_STUB_PATH = resolve(process.cwd(), "__supatype_checker_stubs__.ts")
const SUPATYPE_CHECKER_STUB_SOURCE = `
export type Optional<T> = T;
export type Unique<T> = T;
export type PrimaryKey<T> = T;
export type Localized<T> = T;
export type NotLocalized<T> = T;
export type Default<T, V> = T;
export type Email = string & { readonly __supatypeEmailBrand: unique symbol };
export type UUID = string & { readonly __supatypeUuidBrand: unique symbol };
export type RichText = unknown;
export type Int = number;
export type SmallInt = number;
export type BigInt = number;
export type Timestamp = string;
export type Date = string;
export type DateTime = string;
export type DateOnly = string;
export type Slug<S extends string = string> = string;
export type RelatedTo<T> = string;
export type Text = string;
`

function createCheckerStubFile(): ts.SourceFile {
  return ts.createSourceFile(
    SUPATYPE_CHECKER_STUB_PATH,
    SUPATYPE_CHECKER_STUB_SOURCE,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function createCheckerContext(sourceFiles: ts.SourceFile[]): CheckerContext {
  const stubFile = createCheckerStubFile()
  const fileMap = new Map<string, ts.SourceFile>([
    [resolve(stubFile.fileName), stubFile],
    ...sourceFiles.map((sf) => [resolve(sf.fileName), sf] as const),
  ])
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    skipLibCheck: true,
    baseUrl: process.cwd(),
    paths: {
      "@supatype/types": ["__supatype_checker_stubs__.ts"],
    },
  }

  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const existing = fileMap.get(resolve(fileName))
      if (existing) return existing
      const libContent = ts.sys.readFile(fileName)
      if (libContent) {
        return ts.createSourceFile(fileName, libContent, languageVersion, true)
      }
      return undefined
    },
    getDefaultLibFileName: (opts) => ts.getDefaultLibFileName(opts ?? options),
    writeFile: () => {},
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => ts.sys.newLine,
    fileExists: (fileName) => fileMap.has(resolve(fileName)) || ts.sys.fileExists(fileName),
    readFile: (fileName) => fileMap.get(resolve(fileName))?.getFullText() ?? ts.sys.readFile(fileName),
  }

  const program = ts.createProgram([...fileMap.keys()], options, host)
  return { program, checker: program.getTypeChecker() }
}

function findNodeAtPosition(root: ts.Node, pos: number, end: number): ts.Node | undefined {
  const queue: ts.Node[] = [root]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    if (current.pos === pos && current.end === end) return current
    ts.forEachChild(current, (child) => queue.push(child))
  }
  return undefined
}

function containsConditionalOrMapped(node: ts.Node): boolean {
  if (ts.isConditionalTypeNode(node) || ts.isMappedTypeNode(node)) return true
  let found = false
  ts.forEachChild(node, (child) => {
    if (!found && containsConditionalOrMapped(child)) found = true
  })
  return found
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function unknownTypeError(typeName: string, fieldName: string): Error {
  return new Error(
    `Unknown Supatype type "${typeName}" in field "${fieldName}". ` +
      "If this is a type alias, confirm the file defining it is reachable from your schema entry point.",
  )
}
