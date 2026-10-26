/**
 * The TypeScript a `JSON<T>` column holds, spelled out so a generated file can carry it.
 *
 * `JSON<T>` is how a schema says what shape a JSONB column holds, and the generated row is where a
 * caller reads it. The extractor used to drop `T`, so the column arrived as an opaque object and
 * every reader cast it back to the type the schema had already declared. `T` usually names types
 * declared in the schema (`JSON<ProductFeature[]>`), which the generated file cannot import, so it
 * is written out structurally: `{ title: string; description: string; icon: string }[]`.
 *
 * Only what JSON can hold is written. Anything else (a function, a class instance, a type the
 * checker could not resolve) gives `undefined`, and the column keeps the generic `Json` type rather
 * than a guess.
 */
import ts from "typescript"
import type { ResolveContext } from "./type-resolver.js"

const MAX_DEPTH = 8

const PRIMITIVE =
  ts.TypeFlags.String |
  ts.TypeFlags.Number |
  ts.TypeFlags.Boolean |
  ts.TypeFlags.StringLiteral |
  ts.TypeFlags.NumberLiteral |
  ts.TypeFlags.BooleanLiteral |
  ts.TypeFlags.Null

/** The structural text of `JSON<T>`'s `T`, or `undefined` when there is no `T` or it is not JSON. */
export function jsonTypeArgText(node: ts.TypeNode, ctx: ResolveContext): string | undefined {
  if (!ts.isTypeReferenceNode(node)) return undefined
  const arg = node.typeArguments?.[0]
  if (arg === undefined) return undefined
  const { program, checker } = ctx.getChecker()
  // A node the alias resolver synthesised from substituted text belongs to no file the checker
  // knows, so it cannot be asked about.
  if (program.getSourceFile(arg.getSourceFile().fileName) !== arg.getSourceFile()) return undefined
  return typeText(checker, checker.getTypeFromTypeNode(arg), 0)
}

function typeText(checker: ts.TypeChecker, type: ts.Type, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return undefined
  if (type.flags & PRIMITIVE) return checker.typeToString(type)
  if (type.isUnion()) return unionText(checker, type, depth)
  if (checker.isArrayType(type)) return arrayText(checker, type, depth)
  if (checker.isTupleType(type)) return tupleText(checker, type, depth)
  if (type.flags & ts.TypeFlags.Object) return objectText(checker, type, depth)
  return undefined
}

/**
 * `true | false` is how the checker holds `boolean`; it is written back as `boolean`. `undefined`
 * is dropped: JSON cannot hold it, and an optional property already says it may be absent.
 */
function unionText(checker: ts.TypeChecker, type: ts.UnionType, depth: number): string | undefined {
  const defined = type.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined))
  if (defined.length === 1 && defined[0] !== undefined) return typeText(checker, defined[0], depth)
  const booleans = defined.filter((t) => t.flags & ts.TypeFlags.BooleanLiteral)
  const rest = booleans.length === 2 ? defined.filter((t) => !booleans.includes(t)) : defined
  const parts = rest.map((t) => typeText(checker, t, depth + 1))
  if (parts.some((p) => p === undefined)) return undefined
  return [...(booleans.length === 2 ? ["boolean"] : []), ...parts].join(" | ")
}

function arrayText(checker: ts.TypeChecker, type: ts.Type, depth: number): string | undefined {
  const element = checker.getTypeArguments(type as ts.TypeReference)[0]
  if (element === undefined) return undefined
  const text = typeText(checker, element, depth + 1)
  if (text === undefined) return undefined
  return element.isUnion() ? `(${text})[]` : `${text}[]`
}

function tupleText(checker: ts.TypeChecker, type: ts.Type, depth: number): string | undefined {
  const parts = checker.getTypeArguments(type as ts.TypeReference).map((t) => typeText(checker, t, depth + 1))
  if (parts.some((p) => p === undefined)) return undefined
  return `[${parts.join(", ")}]`
}

function objectText(checker: ts.TypeChecker, type: ts.Type, depth: number): string | undefined {
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return undefined
  const members: string[] = []
  for (const info of checker.getIndexInfosOfType(type)) {
    const value = typeText(checker, info.type, depth + 1)
    if (value === undefined) return undefined
    members.push(`[key: ${checker.typeToString(info.keyType)}]: ${value}`)
  }
  for (const property of checker.getPropertiesOfType(type)) {
    const member = propertyText(checker, property, depth)
    if (member === undefined) return undefined
    members.push(member)
  }
  return members.length === 0 ? "{}" : `{ ${members.join("; ")} }`
}

function propertyText(checker: ts.TypeChecker, property: ts.Symbol, depth: number): string | undefined {
  const optional = (property.flags & ts.SymbolFlags.Optional) !== 0
  const text = typeText(checker, checker.getTypeOfSymbol(property), depth + 1)
  if (text === undefined) return undefined
  const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property.name) ? property.name : JSON.stringify(property.name)
  return `${name}${optional ? "?" : ""}: ${text}`
}
