/**
 * The foreign keys between tables, and the junction tables a many-to-many creates, as the client
 * augmentation describes them.
 *
 * `@supatype/client` reads these to type an embedded select: `select("*, author:authors(*)")` is
 * resolved by finding the key between the two tables and which side holds it. Without them the
 * client could only type the base row, and every project that embedded a relation declared the
 * joined shape by hand.
 *
 * The rules mirror the engine's, because the tables they describe are the ones the engine creates:
 * a `belongsTo` puts `<field>_id` on its own table (or the declared `foreignKey`) referencing the
 * target's `references` column, `id` by default; a `manyToMany` creates the `through` table (or the
 * two names sorted and joined) holding `<model>_id` for each side. Every table and column is named
 * as Postgres keeps it, cut to 63 bytes as the engine cuts it; `tableName` gives the names as
 * stated, since a junction is named from the full names and only then cut.
 */
import { keptName } from "@supatype/shared"
import type { AstModel } from "./augmentation-generator.js"

export interface Relationship {
  columns: string[]
  isOneToOne: boolean
  referencedRelation: string
  referencedColumns: string[]
}

export interface JunctionTable {
  name: string
  columns: Array<{ column: string; ts: string }>
  relationships: Relationship[]
}

type FieldMeta = Record<string, unknown>

export function toSnakeCase(name: string): string {
  return name.replace(/([A-Z])/g, "_$1").replace(/^_/, "").toLowerCase()
}

/** The table a relation's `target` (a model name) lives in, as stated. */
function targetTable(target: string, models: AstModel[], tableName: (m: AstModel) => string): string {
  const model = models.find((m) => m.name === target)
  return model === undefined ? toSnakeCase(target) : tableName(model)
}

function declaredForeignKey(meta: FieldMeta): string | undefined {
  const annotations = meta["annotations"]
  if (typeof annotations !== "object" || annotations === null) return undefined
  const declared = (annotations as { db?: { foreignKey?: unknown } }).db?.foreignKey
  return typeof declared === "string" && declared.length > 0 ? declared : undefined
}

/** The column a `belongsTo` field occupies on its own table. */
export function foreignKeyColumn(name: string, meta: FieldMeta): string {
  return keptName(declaredForeignKey(meta) ?? `${toSnakeCase(name)}_id`)
}

/** Every foreign key `model` holds, one per `belongsTo` field. */
export function relationshipsOf(
  model: AstModel,
  models: AstModel[],
  tableName: (m: AstModel) => string,
): Relationship[] {
  return Object.entries(model.fields ?? {})
    .filter(([, meta]) => meta["kind"] === "relation" && meta["cardinality"] === "belongsTo")
    .map(([name, meta]) => ({
      columns: [foreignKeyColumn(name, meta)],
      isOneToOne: meta["uniqueFk"] === true,
      referencedRelation: keptName(targetTable(String(meta["target"]), models, tableName)),
      referencedColumns: [keptName(typeof meta["references"] === "string" ? meta["references"] : "id")],
    }))
}

/** The primary key column of the model named `name`, and the type a column referencing it holds. */
function primaryKeyOf(name: string, models: AstModel[], tsOf: (meta: FieldMeta) => string) {
  const model = models.find((m) => m.name === name)
  const entry = Object.entries(model?.fields ?? {}).find(([, meta]) => meta["primaryKey"] === true)
  return entry === undefined
    ? { column: "id", ts: "string" }
    : { column: entry[0], ts: tsOf({ ...entry[1], required: true }) }
}

interface JunctionContext {
  models: AstModel[]
  tableName: (m: AstModel) => string
  tsOf: (meta: FieldMeta) => string
}

/** A junction's name and its two models in column order, as the engine resolves them. */
function junctionEnds(model: AstModel, meta: FieldMeta, ctx: JunctionContext): { name: string; ends: string[] } {
  const target = String(meta["target"])
  if (typeof meta["through"] === "string") return { name: keptName(meta["through"]), ends: [model.name ?? "", target] }
  // Both tables, sorted (ties by model name), as the engine names it: `post_tag` from either side
  // and either declaration order. It was one side's table plus the other side's model name, which
  // named `Post_tag` and `Tag_post`, tables the database no longer has.
  const self = { table: ctx.tableName(model), name: model.name ?? "" }
  const other = { table: targetTable(target, ctx.models, ctx.tableName), name: target }
  const selfFirst = self.table === other.table ? compare(self.name, other.name) <= 0 : compare(self.table, other.table) < 0
  const [a, b] = selfFirst ? [self, other] : [other, self]
  return { name: keptName(`${a.table}_${b.table}`), ends: [a.name, b.name] }
}

/** Byte order, as the engine's Rust `sort` compares strings, not the locale's. */
function compare(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0
}

function junctionFor(model: AstModel, meta: FieldMeta, ctx: JunctionContext): JunctionTable {
  const { name, ends } = junctionEnds(model, meta, ctx)
  const sides = ends.map((side) => ({
    column: keptName(`${toSnakeCase(side)}_id`),
    key: primaryKeyOf(side, ctx.models, ctx.tsOf),
    table: keptName(targetTable(side, ctx.models, ctx.tableName)),
  }))
  return {
    name,
    columns: sides.map(({ column, key }) => ({ column, ts: key.ts })),
    relationships: sides.map(({ column, key, table }) => ({
      columns: [column],
      isOneToOne: false,
      referencedRelation: table,
      referencedColumns: [key.column],
    })),
  }
}

/** One junction per `through` name, from whichever side declares the relation first. */
export function junctionTablesOf(ctx: JunctionContext): JunctionTable[] {
  const byName = new Map<string, JunctionTable>()
  for (const model of ctx.models) {
    for (const meta of Object.values(model.fields ?? {})) {
      if (meta["kind"] !== "relation" || meta["cardinality"] !== "manyToMany") continue
      const junction = junctionFor(model, meta, ctx)
      if (!byName.has(junction.name)) byName.set(junction.name, junction)
    }
  }
  return [...byName.values()]
}

/** `Relationships: [...]`, as a tuple type, with its first line unindented. */
export function renderRelationships(relationships: Relationship[], indent: number): string {
  if (relationships.length === 0) return "Relationships: []"
  const pad = " ".repeat(indent)
  const list = (values: string[]): string => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`
  const entries = relationships.map((r) =>
    [
      `${pad}  {`,
      `${pad}    columns: ${list(r.columns)}`,
      `${pad}    isOneToOne: ${r.isOneToOne}`,
      `${pad}    referencedRelation: ${JSON.stringify(r.referencedRelation)}`,
      `${pad}    referencedColumns: ${list(r.referencedColumns)}`,
      `${pad}  },`,
    ].join("\n"),
  )
  return `Relationships: [\n${entries.join("\n")}\n${pad}]`
}
