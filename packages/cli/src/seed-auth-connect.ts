/**
 * `authUser: { connect: { id } }` for a relation to the auth user, written as its key column.
 *
 * The auth user is not a model of the schema, so the engine has no model to resolve a `connect`
 * against and refused it as "`supatype:user` is not a model in this schema". An auth user is only
 * ever named by its id, and the id is what the key column holds, so the connect needs no lookup:
 * `authUser: { connect: { id } }` is `auth_user_id: id`. Done here, in the CLI, because the schema
 * is the only place that says which column the relation's key is.
 */

import { isJsonObject } from "@supatype/shared"
import type { SeedData, SeedIr, SeedOperation, SeedValue } from "./seed.js"
import type { ModelAstV2 } from "./schema-ast-v2.js"
import { foreignKeyColumn } from "./augmentation-relationships.js"
import type { ExtractedSchemaAst } from "./type-extractor.js"

type Models = ReadonlyMap<string, ModelAstV2>

/** The IR with every connect to an auth user written as the relation's key column. */
export function connectAuthUsersByKey(ir: SeedIr, ast: ExtractedSchemaAst): SeedIr {
  const models: Models = new Map(ast.models.map((model) => [model.name, model]))
  return { ...ir, operations: ir.operations.map((operation) => lowerOperation(operation, models)) }
}

function lowerOperation(operation: SeedOperation, models: Models): SeedOperation {
  switch (operation.op) {
    case "create":
      return { ...operation, data: lowerRow(operation.model, operation.data, models) }
    case "createMany":
      return { ...operation, rows: operation.rows.map((row) => lowerRow(operation.model, row, models)) }
    case "upsert":
      return {
        ...operation,
        where: lowerRow(operation.model, operation.where, models),
        data: lowerRow(operation.model, operation.data, models),
      }
    case "group":
      return { ...operation, operations: operation.operations.map((inner) => lowerOperation(inner, models)) }
    case "sql":
      return operation
  }
}

/** The auth user's system target: the one relation target that is no model of the schema. */
const AUTH_USER_TARGET = "supatype:user"

/** One row of `modelName`: its auth user connects rewritten, and the rows nested under it too. */
function lowerRow(modelName: string, row: SeedData, models: Models): SeedData {
  const model = models.get(modelName)
  if (model === undefined) return row
  const out: SeedData = {}
  for (const [key, value] of Object.entries(row)) {
    const field = model.fields[key]
    const target = field?.kind === "relation" ? field["target"] : undefined
    if (typeof target === "string" && models.has(target)) {
      out[key] = lowerNested(target, value, models)
    } else if (field !== undefined && target === AUTH_USER_TARGET && isConnect(value)) {
      const column = foreignKeyColumn(key, field)
      out[column] = connectedId(`${modelName}.${key}`, column, value.connect)
    } else {
      out[key] = value
    }
  }
  return out
}

/** Rows nested under a relation to a model of the schema, which may connect auth users of their own. */
function lowerNested(target: string, value: SeedValue, models: Models): SeedValue {
  const shape = asSeedData(value)
  if (shape === undefined) return value
  const nested: SeedData = { ...shape }
  for (const key of ["create", "createMany"] as const) {
    const rows = shape[key]
    if (isSeedList(rows)) nested[key] = rows.map((row) => (isSeedData(row) ? lowerRow(target, row, models) : row))
  }
  return nested
}

function isConnect(value: SeedValue): value is { connect: SeedData } {
  const shape = asSeedData(value)
  return shape !== undefined && Object.keys(shape).length === 1 && isSeedData(shape["connect"])
}

/** `Array.isArray` narrows to `any[]`; this keeps the elements typed. */
function isSeedList(value: SeedValue | undefined): value is readonly SeedValue[] {
  return Array.isArray(value)
}

/** The value as a row, or undefined. Through `unknown`, as narrowing a `SeedValue` directly keeps the operand members. */
function asSeedData(value: unknown): SeedData | undefined {
  return isSeedData(value) ? value : undefined
}

/** A row-shaped value. */
function isSeedData(value: unknown): value is SeedData {
  return isJsonObject(value)
}

/** The id an auth user connect names, refusing any other key: an auth user has no other to look up. */
function connectedId(where: string, column: string, connect: SeedData): SeedValue {
  const keys = Object.keys(connect)
  const id = connect["id"]
  if (keys.length === 1 && id !== undefined) return id
  throw new Error(
    `${where} connects to an auth user, which a seed names by its id only: ` +
      `\`{ connect: { id } }\`, or set \`${column}\` directly. It was given ${keys.join(", ") || "no key"}.`,
  )
}
