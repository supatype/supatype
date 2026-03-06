/**
 * Utilities for the `pull` command — extracted for unit testability.
 */

export interface ColumnInfo {
  name: string
  pgType: string
  nullable: boolean
  isPrimary: boolean
  isUnique: boolean
  hasDefault: boolean
}

/** Map a Postgres column type to the corresponding field.X() call string. */
export function pgTypeToField(col: ColumnInfo): string {
  const opts: Record<string, unknown> = { required: !col.nullable }
  if (col.isPrimary) opts["primaryKey"] = true
  if (col.isUnique && !col.isPrimary) opts["unique"] = true
  const optsStr = JSON.stringify(opts)

  const type = col.pgType.toLowerCase()

  if (type.includes("uuid")) return `field.uuid(${optsStr})`
  if (type.includes("text") || type.includes("varchar") || type.includes("char"))
    return `field.text(${optsStr})`
  if (type.includes("int8") || type.includes("bigint")) return `field.bigInt(${optsStr})`
  if (type.includes("int2") || type.includes("smallint")) return `field.smallInt(${optsStr})`
  if (type.includes("interval")) return `field.interval(${optsStr})`
  if (type.includes("int") || type.includes("serial")) return `field.integer(${optsStr})`
  if (type.includes("float") || type.includes("double") || type.includes("real"))
    return `field.float(${optsStr})`
  if (type.includes("numeric") || type.includes("decimal")) return `field.decimal(${optsStr})`
  if (type.includes("bool")) return `field.boolean(${optsStr})`
  if (type.includes("timestamptz") || type.includes("timestamp with time zone"))
    return `field.datetime(${optsStr})`
  if (type.includes("timestamp")) return `field.timestamp(${optsStr})`
  if (type.includes("date")) return `field.date(${optsStr})`
  if (type.includes("jsonb")) return `field.json({ ...${optsStr}, jsonb: true })`
  if (type.includes("json")) return `field.json(${optsStr})`
  if (type.includes("inet")) return `field.ip(${optsStr})`
  if (type.includes("cidr")) return `field.cidr(${optsStr})`
  if (type.includes("macaddr")) return `field.macaddr(${optsStr})`
  if (type.includes("bytea")) return `field.bytea(${optsStr})`
  if (type.includes("money")) return `field.money(${optsStr})`
  if (type.includes("xml")) return `field.xml(${optsStr})`
  if (type.includes("tsvector")) return `field.tsvector(${optsStr})`
  if (type.includes("tsquery")) return `field.tsquery(${optsStr})`

  return `field.text({ ...${optsStr} }) /* TODO: ${col.pgType} */`
}

/** Convert snake_case table name to PascalCase model export name. */
export function toCamelCase(s: string): string {
  return s
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
    .replace(/^([a-z])/, (c: string) => c.toUpperCase())
}
