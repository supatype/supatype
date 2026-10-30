import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import {
  Node,
  Project,
  QuoteKind,
  SyntaxKind,
  ts,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type SourceFile,
} from "ts-morph"

export interface UpdateAppConfigInput {
  mode: "none" | "static" | "proxy"
  staticDir?: string
  upstream?: string
}

export interface UpdateServerConfigInput {
  domain: string
  tlsEmail: string
  provider?: "kong" | "none"
}

/**
 * What a writer puts in one block of the config: the keys it owns, and the value text of those it
 * sets. An owned key it does not set is removed; every other key of the block is kept as written.
 */
interface BlockEntries {
  owned: readonly string[]
  set: ReadonlyArray<readonly [key: string, valueText: string]>
}

export function updateAppConfigInProject(cwd: string, input: UpdateAppConfigInput): string {
  return rewriteConfigBlock(cwd, "app", appEntries(input))
}

/**
 * Set `server.mode = "standalone"` plus `domain` and `tls` in supatype.config.ts,
 * enabling self-host HTTPS. Preserves other `server` keys (port, etc).
 */
export function updateServerConfigInProject(cwd: string, input: UpdateServerConfigInput): string {
  return rewriteConfigBlock(cwd, "server", serverEntries(input))
}

function appEntries(input: UpdateAppConfigInput): BlockEntries {
  const set: Array<readonly [string, string]> = [["mode", JSON.stringify(input.mode)]]
  if (input.mode === "proxy") set.push(["upstream", JSON.stringify(input.upstream ?? "http://localhost:3000")])
  if (input.mode === "static") set.push(["static_dir", JSON.stringify(input.staticDir ?? "./dist")])
  return { owned: ["mode", "upstream", "static_dir"], set }
}

function serverEntries(input: UpdateServerConfigInput): BlockEntries {
  const provider = input.provider ?? "kong"
  return {
    owned: ["mode", "domain", "tls"],
    set: [
      ["mode", JSON.stringify("standalone")],
      ["domain", JSON.stringify(input.domain)],
      ["tls", `{ email: ${JSON.stringify(input.tlsEmail)}, provider: ${JSON.stringify(provider)} }`],
    ],
  }
}

function rewriteConfigBlock(cwd: string, key: string, entries: BlockEntries): string {
  const configPath = resolve(cwd, "supatype.config.ts")
  if (!existsSync(configPath)) {
    throw new Error("supatype.config.ts not found. Run: supatype init")
  }
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    manipulationSettings: { quoteKind: QuoteKind.Double },
  })
  const sourceFile = project.createSourceFile(configPath, readFileSync(configPath, "utf8"), { overwrite: true })
  writeFileSync(configPath, withBlock(sourceFile, getRootConfigObject(sourceFile), key, entries), "utf8")
  return configPath
}

/**
 * The config text with `key: { ... }` in its root object, laid out one entry per line at the
 * indentation the file already uses. Spliced as text rather than through ts-morph's manipulation,
 * which against init's trailing commas wrote `mode: "proxy",,` and re-indented what it inserted to
 * nothing around it.
 */
function withBlock(sourceFile: SourceFile, root: ObjectLiteralExpression, key: string, entries: BlockEntries): string {
  const property = root.getProperty(key)
  const initializer = property !== undefined && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined
  if (property !== undefined && initializer === undefined) property.remove()
  const text = sourceFile.getFullText()
  if (property !== undefined && initializer !== undefined) {
    const existing = Node.isObjectLiteralExpression(initializer) ? initializer.getProperties() : []
    const block = renderObject(mergeEntries(existing, entries), lineIndent(text, property.getStart()))
    return splice(text, initializer.getStart(), initializer.getEnd(), block)
  }
  return withAppendedProperty(text, root, key, renderObject(mergeEntries([], entries), indentationOf(text, root)))
}

function splice(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end)
}

/** The block's lines: kept keys where they were, owned keys set in place or appended, or dropped. */
function mergeEntries(existing: readonly ObjectLiteralElementLike[], entries: BlockEntries): string[] {
  const values = new Map(entries.set)
  const written = new Set<string>()
  const lines: string[] = []
  for (const element of existing) {
    const name = elementName(element)
    if (name === undefined || !entries.owned.includes(name)) {
      // With its leading comments, which getText() leaves out.
      lines.push(element.getFullText().trim())
      continue
    }
    const value = values.get(name)
    if (value !== undefined) lines.push(`${name}: ${value}`)
    written.add(name)
  }
  for (const [name, value] of entries.set) {
    if (!written.has(name)) lines.push(`${name}: ${value}`)
  }
  return lines
}

function elementName(element: ObjectLiteralElementLike): string | undefined {
  if (Node.isPropertyAssignment(element) || Node.isShorthandPropertyAssignment(element)) return element.getName()
  return undefined
}

function renderObject(lines: readonly string[], indent: string): string {
  return `{\n${lines.map((line) => `${indent}  ${line},`).join("\n")}\n${indent}}`
}

/** The indentation of the root object's entries: that of its first entry, else two spaces. */
function indentationOf(text: string, root: ObjectLiteralExpression): string {
  const first = root.getProperties()[0]
  return first === undefined ? "  " : lineIndent(text, first.getStart())
}

/** The whitespace that starts the line `pos` is on. */
function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart, pos))?.[0] ?? ""
}

/**
 * `text` with `key: value,` as the root object's last entry, adding the comma the entry before may
 * lack. The separator is the parser's comma token, so a comma inside a comment beside the entry is
 * never taken for it, and the new entry goes after any comment on the separator's line, which stays
 * with the entry it was written beside.
 */
function withAppendedProperty(text: string, root: ObjectLiteralExpression, key: string, value: string): string {
  const entry = `\n${indentationOf(text, root)}${key}: ${value},`
  const last = root.getProperties().at(-1)
  if (last === undefined) return splice(text, root.getStart() + 1, root.getStart() + 1, `${entry}\n`)
  const comma = last.getNextSiblingIfKind(SyntaxKind.CommaToken)
  const separatorEnd = comma?.getEnd() ?? last.getEnd()
  const at = ts.getTrailingCommentRanges(text, separatorEnd)?.at(-1)?.end ?? separatorEnd
  const appended = splice(text, at, at, entry)
  return comma === undefined ? splice(appended, last.getEnd(), last.getEnd(), ",") : appended
}

function getRootConfigObject(sourceFile: SourceFile): ObjectLiteralExpression {
  const exportAssignment = sourceFile.getFirstDescendantByKind(SyntaxKind.ExportAssignment)
  if (!exportAssignment) {
    throw new Error("Could not find default export in supatype.config.ts.")
  }
  const expr = exportAssignment.getExpression()
  if (Node.isObjectLiteralExpression(expr)) {
    return expr
  }
  if (Node.isCallExpression(expr)) {
    const [firstArg] = expr.getArguments()
    if (firstArg && Node.isObjectLiteralExpression(firstArg)) {
      return firstArg
    }
  }
  throw new Error(
    "supatype.config.ts must export an object literal or defineConfig({...}).",
  )
}
