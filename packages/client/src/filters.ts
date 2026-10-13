/**
 * The PostgREST row filters, in one place for reads and writes alike.
 *
 * `QueryBuilder` and `MutationBuilder` both extend this, so an update or a delete narrows its rows
 * with exactly the operators a select has. They used to be written out twice, and the mutation copy
 * stopped at `eq`, `neq` and `in`, which left a ranged or patterned delete impossible without a
 * read first.
 */

/** A Postgres array literal element needs quoting when it is empty, spells NULL, or holds syntax. */
const ARRAY_ELEMENT_NEEDS_QUOTES = /^$|^null$|[\s,{}"\\]/i

/** An `in.(...)` value needs quoting when it holds the list's own delimiters. */
const IN_VALUE_NEEDS_QUOTES = /[,()]/

function quoteArrayElement(text: string): string {
  if (!ARRAY_ELEMENT_NEEDS_QUOTES.test(text)) return text
  return `"${text.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`
}

function arrayElement(value: unknown): string {
  if (value === null || value === undefined) return "NULL"
  if (Array.isArray(value)) return toPostgresArrayLiteral(value)
  if (typeof value === "object") return quoteArrayElement(JSON.stringify(value))
  return quoteArrayElement(String(value))
}

/**
 * `["a", "b c"]` as PostgreSQL's array input syntax: `{a,"b c"}`.
 *
 * Elements are quoted only when PostgreSQL would otherwise split or reinterpret them, so the common
 * case stays readable in logs. `null` is the SQL NULL; the string `"null"` is quoted to stay a string.
 */
export function toPostgresArrayLiteral(values: readonly unknown[]): string {
  return `{${values.map(arrayElement).join(",")}}`
}

/**
 * The operand for `cs` and `cd`, chosen by the shape of the value as supabase-js does.
 *
 * - an array is a Postgres array column's operand, so it goes as an array literal;
 * - a string is sent as written, for range types and literals the caller has already formed;
 * - anything else is a jsonb operand, so it goes as JSON.
 *
 * For a jsonb column holding an array, pass `JSON.stringify([...])`: a bare array means a Postgres
 * array here, which is the far more common column.
 */
export function containmentOperand(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return toPostgresArrayLiteral(value)
  return JSON.stringify(value)
}

function inListValue(value: unknown): string {
  const text = String(value)
  return IN_VALUE_NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}

export abstract class FilterBuilder {
  protected readonly params = new URLSearchParams()

  private filter(column: string, operator: string, operand: string): this {
    this.params.append(column, `${operator}.${operand}`)
    return this
  }

  eq(column: string, value: unknown): this {
    return this.filter(column, "eq", String(value))
  }

  neq(column: string, value: unknown): this {
    return this.filter(column, "neq", String(value))
  }

  gt(column: string, value: unknown): this {
    return this.filter(column, "gt", String(value))
  }

  gte(column: string, value: unknown): this {
    return this.filter(column, "gte", String(value))
  }

  lt(column: string, value: unknown): this {
    return this.filter(column, "lt", String(value))
  }

  lte(column: string, value: unknown): this {
    return this.filter(column, "lte", String(value))
  }

  like(column: string, pattern: string): this {
    return this.filter(column, "like", pattern)
  }

  ilike(column: string, pattern: string): this {
    return this.filter(column, "ilike", pattern)
  }

  /** Values holding a comma or a parenthesis are quoted, so PostgREST does not split them. */
  in(column: string, values: unknown[]): this {
    return this.filter(column, "in", `(${values.map(inListValue).join(",")})`)
  }

  is(column: string, value: null | boolean): this {
    return this.filter(column, "is", String(value))
  }

  not(column: string, op: string, value: unknown): this {
    return this.filter(column, "not", `${op}.${String(value)}`)
  }

  /** Rows whose array, range or jsonb `column` contains `value`. See `containmentOperand`. */
  contains(column: string, value: unknown): this {
    return this.filter(column, "cs", containmentOperand(value))
  }

  /** Rows whose array, range or jsonb `column` is contained by `value`. See `containmentOperand`. */
  containedBy(column: string, value: unknown): this {
    return this.filter(column, "cd", containmentOperand(value))
  }

  /** One `eq` filter per entry: `match({ author: "ann", lang: "en" })`. */
  match(query: Record<string, unknown>): this {
    for (const [column, value] of Object.entries(query)) this.eq(column, value)
    return this
  }

  /** PostgREST OR filter: pass conditions in PostgREST syntax, e.g. `"status.eq.active,owner_id.eq.123"`. */
  or(filters: string): this {
    this.params.append("or", `(${filters})`)
    return this
  }
}
