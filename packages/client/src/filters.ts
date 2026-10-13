/**
 * The PostgREST row filters, in one place for reads and writes alike.
 *
 * `QueryBuilder` and `MutationBuilder` both extend this, so an update or a delete narrows its rows
 * with exactly the operators a select has. They used to be written out twice, and the mutation copy
 * stopped at `eq`, `neq` and `in`, which left a ranged or patterned delete impossible without a
 * read first.
 */

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

  in(column: string, values: unknown[]): this {
    return this.filter(column, "in", `(${values.map(String).join(",")})`)
  }

  is(column: string, value: null | boolean): this {
    return this.filter(column, "is", String(value))
  }

  not(column: string, op: string, value: unknown): this {
    return this.filter(column, "not", `${op}.${String(value)}`)
  }

  /** Rows whose array, range or jsonb `column` contains `value`. */
  contains(column: string, value: unknown): this {
    return this.filter(column, "cs", JSON.stringify(value))
  }

  /** Rows whose array, range or jsonb `column` is contained by `value`. */
  containedBy(column: string, value: unknown): this {
    return this.filter(column, "cd", JSON.stringify(value))
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
