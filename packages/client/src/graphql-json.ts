/**
 * Turning pg_graphql's `JSON` scalar strings back into the values they encode.
 *
 * pg_graphql types every json and jsonb column (rich text, blocks, json fields, and any function or
 * view returning one) as its `JSON` scalar, "a Javascript Object Notation value serialized as a
 * string". The scalar is the only reliable marker: the generated field kinds know a model's columns
 * but not the names pg_graphql gives its connection, edge and relation types, so the schema itself
 * is asked, once per role, and each answer is walked against the query that produced it.
 *
 * A key is decoded only when every field selected under it is a `JSON` scalar. A key the schema
 * does not know, a document with more than one operation, or a string that does not parse is left
 * as the server sent it.
 */
import { parseGraphqlDocument, type GraphqlDocument, type GraphqlOperationKind, type GraphqlSelection } from "./graphql-document.js"
import { isArrayOf, isJsonObject, isShape, isString } from "./json.js"

/** What the client needs from a GraphQL schema: each type's fields, by the type they return. */
export type GraphqlSchema = {
  readonly roots: Readonly<Partial<Record<GraphqlOperationKind, string>>>
  /** Type name to field name to the named type the field returns, lists and non-null removed. */
  readonly types: ReadonlyMap<string, ReadonlyMap<string, string>>
  readonly jsonScalars: ReadonlySet<string>
}

/** The answer with its `JSON` fields decoded, and whether the schema was missing a field it used. */
export type GraphqlJsonDecoding = { readonly data: unknown; readonly schemaIsStale: boolean }

/** pg_graphql's name for the scalar it gives json and jsonb. */
const JSON_SCALAR = "JSON"

const TYPE_REF = "kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }"

/** The introspection query whose `data` {@link readGraphqlSchema} reads. */
export const GRAPHQL_SCHEMA_QUERY =
  "query SupatypeSchemaFields { __schema { queryType { name } mutationType { name } subscriptionType { name } " +
  `types { name kind fields(includeDeprecated: true) { name type { ${TYPE_REF} } } } } }`

type TypeRef = { kind: string; name: string | null; ofType?: TypeRef | null }

function isTypeRef(value: unknown): value is TypeRef {
  if (!isJsonObject(value) || !isString(value["kind"])) return false
  const name = value["name"]
  const ofType = value["ofType"]
  return (name === null || isString(name)) && (ofType === undefined || ofType === null || isTypeRef(ofType))
}

const isField = isShape({ name: isString, type: isTypeRef })
const isType = isShape({ name: isString, kind: isString })

function namedType(ref: TypeRef): string | null {
  return ref.ofType === undefined || ref.ofType === null ? ref.name : namedType(ref.ofType)
}

function rootName(value: unknown): string | null {
  return isJsonObject(value) && isString(value["name"]) ? value["name"] : null
}

/** The fields of one introspected type, or none for a scalar, enum or input. */
function fieldsOf(type: Record<string, unknown>): Map<string, string> {
  const fields = new Map<string, string>()
  const declared = type["fields"]
  if (!Array.isArray(declared)) return fields
  for (const field of declared) {
    if (!isField(field)) continue
    const returns = namedType(field.type)
    if (returns !== null) fields.set(field.name, returns)
  }
  return fields
}

function rootsOf(schema: Record<string, unknown>): Partial<Record<GraphqlOperationKind, string>> {
  const roots: Partial<Record<GraphqlOperationKind, string>> = {}
  const entries = [["query", "queryType"], ["mutation", "mutationType"], ["subscription", "subscriptionType"]] as const
  for (const [kind, key] of entries) {
    const name = rootName(schema[key])
    if (name !== null) roots[kind] = name
  }
  return roots
}

/** The schema in the `data` of a {@link GRAPHQL_SCHEMA_QUERY} answer, or null when it is not one. */
export function readGraphqlSchema(data: unknown): GraphqlSchema | null {
  const schema = isJsonObject(data) ? data["__schema"] : undefined
  if (!isJsonObject(schema)) return null
  const types = schema["types"]
  if (!isArrayOf(isType)(types)) return null
  const fields = new Map<string, ReadonlyMap<string, string>>()
  const jsonScalars = new Set<string>()
  for (const type of types) {
    if (type.kind === "SCALAR" && type.name === JSON_SCALAR) jsonScalars.add(type.name)
    fields.set(type.name, fieldsOf(type))
  }
  return { roots: rootsOf(schema), types: fields, jsonScalars }
}

/** A selection set, and the type its fields are looked up on. */
type Scope = { readonly selections: readonly GraphqlSelection[]; readonly type: string }

/** Everything selected under one response key. Decoded only when it is unambiguous. */
type Entry = { json: boolean; other: boolean; readonly children: Scope[]; childEntries?: Map<string, Entry> }

type Walk = { readonly schema: GraphqlSchema; readonly document: GraphqlDocument; stale: boolean }

/**
 * `data` with every `JSON` scalar field of `query` decoded, following aliases, fragments, nested
 * selections and lists. For a GraphQL client other than this one, given the schema it introspected.
 */
export function decodeGraphqlJsonFields(query: string, data: unknown, schema: GraphqlSchema): GraphqlJsonDecoding {
  const document = parseGraphqlDocument(query)
  const operation = document?.operations.length === 1 ? document.operations[0] : undefined
  const root = operation === undefined ? undefined : schema.roots[operation.kind]
  if (document === null || operation === undefined || root === undefined) return { data, schemaIsStale: false }
  const walk: Walk = { schema, document, stale: false }
  const decoded = decodeWith(data, entriesFor([{ selections: operation.selections, type: root }], walk), walk)
  return { data: decoded, schemaIsStale: walk.stale }
}

function entriesFor(scopes: readonly Scope[], walk: Walk): Map<string, Entry> {
  const entries = new Map<string, Entry>()
  for (const scope of scopes) collect(entries, scope, walk, new Set())
  return entries
}

function collect(entries: Map<string, Entry>, scope: Scope, walk: Walk, fragmentsSeen: ReadonlySet<string>): void {
  for (const selection of scope.selections) {
    if (selection.kind === "field") {
      addField(entries, selection, scope.type, walk)
    } else if (selection.kind === "inline") {
      collect(entries, { selections: selection.selections, type: selection.typeCondition ?? scope.type }, walk, fragmentsSeen)
    } else {
      const fragment = walk.document.fragments.get(selection.fragment)
      if (fragment === undefined || fragmentsSeen.has(selection.fragment)) continue
      const seen = new Set([...fragmentsSeen, selection.fragment])
      collect(entries, { selections: fragment.selections, type: fragment.typeCondition }, walk, seen)
    }
  }
}

type FieldSelection = Extract<GraphqlSelection, { kind: "field" }>

function addField(entries: Map<string, Entry>, field: FieldSelection, type: string, walk: Walk): void {
  const entry = entries.get(field.key) ?? { json: false, other: false, children: [] }
  entries.set(field.key, entry)
  if (field.name.startsWith("__")) {
    entry.other = true
    return
  }
  const returns = walk.schema.types.get(type)?.get(field.name)
  if (returns === undefined) {
    entry.other = true
    walk.stale = true
  } else if (walk.schema.jsonScalars.has(returns)) {
    entry.json = true
  } else if (field.selections.length > 0) {
    entry.children.push({ selections: field.selections, type: returns })
  } else {
    entry.other = true
  }
}

/** `value` with `entries` applied to it, or to each item when it is a list. */
function decodeWith(value: unknown, entries: ReadonlyMap<string, Entry>, walk: Walk): unknown {
  if (Array.isArray(value)) return value.map((item) => decodeWith(item, entries, walk))
  if (!isJsonObject(value)) return value
  const decoded: Record<string, unknown> = { ...value }
  for (const [key, entry] of entries) {
    if (key in value) decoded[key] = decodeEntry(value[key], entry, walk)
  }
  return decoded
}

function decodeEntry(value: unknown, entry: Entry, walk: Walk): unknown {
  if (entry.other) return value
  if (entry.json && entry.children.length === 0) return decodeJson(value)
  if (entry.json || entry.children.length === 0) return value
  // Collected once per entry, not once per object: `edges { node }` visits `node` for every edge.
  entry.childEntries ??= entriesFor(entry.children, walk)
  return decodeWith(value, entry.childEntries, walk)
}

/** The value a `JSON` scalar string encodes, through lists; anything else as it is. */
function decodeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeJson)
  if (typeof value !== "string") return value
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed
  } catch {
    return value
  }
}

/** True when `value` holds a string anywhere: an answer without one has nothing to decode. */
function containsString(value: unknown): boolean {
  if (typeof value === "string") return true
  if (Array.isArray(value)) return value.some(containsString)
  return isJsonObject(value) && Object.values(value).some(containsString)
}

/**
 * Schemas by whoever reads them. pg_graphql shows each Postgres role only what it may use, so an
 * anonymous caller's schema can lack types a signed-in one has. A failed read is not kept, and
 * neither is a schema an answer showed to be stale: the next call reads it again.
 */
export class GraphqlSchemaCache {
  private readonly schemas = new Map<string, Promise<GraphqlSchema | null>>()

  get(key: string, load: () => Promise<GraphqlSchema | null>): Promise<GraphqlSchema | null> {
    const cached = this.schemas.get(key)
    if (cached !== undefined) return cached
    const loading = load().catch(() => null).then((schema) => {
      if (schema === null) this.schemas.delete(key)
      return schema
    })
    this.schemas.set(key, loading)
    return loading
  }

  forget(key: string): void {
    this.schemas.delete(key)
  }
}

/** Where a schema comes from: whose it is, and how to read it when the cache has none. */
export type GraphqlSchemaSource = {
  readonly key: () => Promise<string>
  readonly load: () => Promise<GraphqlSchema | null>
}

/** `data` decoded against the schema `source` names, read once when an answer first needs it. */
export async function decodeGraphqlAnswer(
  answer: { readonly query: string; readonly data: unknown },
  schemas: GraphqlSchemaCache,
  source: GraphqlSchemaSource,
): Promise<unknown> {
  if (!containsString(answer.data)) return answer.data
  const key = await source.key()
  const schema = await schemas.get(key, source.load)
  if (schema === null) return answer.data
  const { data, schemaIsStale } = decodeGraphqlJsonFields(answer.query, answer.data, schema)
  if (schemaIsStale) schemas.forget(key)
  return data
}
