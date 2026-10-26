/**
 * The row a select string returns, read from the string itself.
 *
 * `select("*, author:authors(*)")` used to be typed as the table's row whatever the string said, so
 * a caller embedding a relation had to declare the joined shape by hand and keep it in step with the
 * string. That is a second copy of the query, and the type said nothing when the two drifted. This
 * reads PostgREST's select grammar at the type level and resolves each embedded resource through the
 * `Relationships` the generator writes for every table.
 *
 * What is understood: `*`, columns, `alias:column`, `column::cast`, JSON paths (`data->a->>b`),
 * embedded resources (`rel(...)`, `alias:rel(...)`, nested) with `!inner` and a foreign-key column
 * hint (`rel!author_id(...)`), in both directions of a foreign key and through a junction table.
 *
 * A to-one embed is `Row | null` unless it is `!inner`. A foreign key that is NOT NULL does not make
 * the embed non-null: row level security can hide the referenced row while the referencing one stays
 * readable, and PostgREST then returns `null` for it. `!inner` drops such rows instead, so there the
 * embed is the row.
 *
 * A name the schema does not have becomes a {@link SelectError} rather than `unknown`, so the mistake
 * surfaces where the value is used, with the reason in the type.
 */
import type { TableDef } from "./types.js"

/** One foreign key, as the generator describes it on the table that holds it. */
export interface TableRelationship {
  columns: readonly string[]
  isOneToOne: boolean
  referencedRelation: string
  referencedColumns: readonly string[]
}

/** What a select string named that the schema does not have, with the reason. */
export interface SelectError<TMessage extends string> {
  readonly selectError: TMessage
}

type Tables = Record<string, TableDef>

/** The row `select(columns)` resolves to on table `TName`. */
export type SelectRow<TTables extends Tables, TName extends string, TColumns extends string> =
  string extends TColumns
    ? RowOf<TTables, TName>
    : ParseFields<TTables, TName, SplitTopLevel<TColumns>>

// ─── Grammar ──────────────────────────────────────────────────────────────────

type Space = " " | "\n" | "\t" | "\r"
type TrimStart<S extends string> = S extends `${infer C}${infer R}` ? (C extends Space ? TrimStart<R> : S) : S
type TrimEnd<S extends string> = S extends `${infer R}${Space}` ? TrimEnd<R> : S
type Trim<S extends string> = TrimEnd<TrimStart<S>>

type Push<TAcc extends string[], TItem extends string> = Trim<TItem> extends "" ? TAcc : [...TAcc, Trim<TItem>]

/** Split on the commas outside any parentheses: `a, b(c, d)` is two fields, not three. */
type SplitTopLevel<
  S extends string,
  TDepth extends 0[] = [],
  TCurrent extends string = "",
  TAcc extends string[] = [],
> = S extends `${infer C}${infer Rest}`
  ? C extends "("
    ? SplitTopLevel<Rest, [...TDepth, 0], `${TCurrent}${C}`, TAcc>
    : C extends ")"
      ? SplitTopLevel<Rest, TDepth extends [0, ...infer Outer extends 0[]] ? Outer : [], `${TCurrent}${C}`, TAcc>
      : C extends ","
        ? TDepth extends []
          ? SplitTopLevel<Rest, TDepth, "", Push<TAcc, TCurrent>>
          : SplitTopLevel<Rest, TDepth, `${TCurrent}${C}`, TAcc>
        : SplitTopLevel<Rest, TDepth, `${TCurrent}${C}`, TAcc>
  : Push<TAcc, TCurrent>

type Simplify<T> = { [K in keyof T]: T[K] } & {}

type ParseFields<TTables extends Tables, TName extends string, TFields extends string[]> =
  TFields extends ["*"]
    ? RowOf<TTables, TName>
    : Simplify<MergeFields<TTables, TName, TFields>>

type MergeFields<TTables extends Tables, TName extends string, TFields extends string[], TAcc = unknown> =
  TFields extends [infer F extends string, ...infer Rest extends string[]]
    ? MergeFields<TTables, TName, Rest, TAcc & ParseField<TTables, TName, F>>
    : TAcc

/** `alias:body`, where the alias is what comes before the first `:` unless that is a cast's `::`. */
type ParseField<TTables extends Tables, TName extends string, F extends string> =
  F extends "*"
    ? RowOf<TTables, TName>
    : F extends `${infer Alias}:${infer Body}`
      ? Body extends `:${string}`
        ? Unaliased<TTables, TName, F>
        : Alias extends `${string}(${string}`
          ? Unaliased<TTables, TName, F>
          : { [K in Trim<Alias>]: FieldType<TTables, TName, Trim<Body>> }
      : Unaliased<TTables, TName, F>

type Unaliased<TTables extends Tables, TName extends string, F extends string> = {
  [K in NaturalName<F>]: FieldType<TTables, TName, F>
}

/** The key PostgREST gives an unaliased field: the resource, the column, or a JSON path's last key. */
type NaturalName<F extends string> =
  F extends `${infer Resource}(${string}` ? ResourceName<Trim<Resource>>
  : F extends `${infer Column}::${string}` ? NaturalName<Column>
  : F extends `${string}->>${infer Rest}` ? NaturalName<Rest>
  : F extends `${string}->${infer Rest}` ? NaturalName<Rest>
  : F

type FieldType<TTables extends Tables, TName extends string, Body extends string> =
  Body extends `${infer Resource}(${infer Inner})`
    ? Embed<TTables, TName, Trim<Resource>, Inner>
    : ColumnType<RowOf<TTables, TName>, TName, Body>

/** The column a field reads, without its cast (`::text`) or JSON path (`->a->>b`). */
type BaseColumn<B extends string> =
  B extends `${infer C}::${string}` ? BaseColumn<C> : B extends `${infer C}->${string}` ? C : B

/** A plain column is its row type; a cast or a JSON path reads a value the schema cannot type. */
type ColumnType<TRow, TName extends string, Body extends string> =
  BaseColumn<Body> extends infer C extends string
    ? C extends keyof TRow
      ? Body extends C ? TRow[C] : unknown
      : SelectError<`column '${C}' does not exist on '${TName}'`>
    : never

// ─── Embedded resources ───────────────────────────────────────────────────────

type ResourceName<R extends string> = R extends `${infer Name}!${string}` ? Name : R

/** `rel!inner!author_id`: the `!` modifiers after a resource name, in any order. */
type Modifiers<R extends string> = R extends `${string}!${infer Rest}` ? SplitBang<Rest> : never
type SplitBang<S extends string> = S extends `${infer Head}!${infer Rest}` ? Head | SplitBang<Rest> : S
type ColumnHint<R extends string> = Exclude<Modifiers<R>, "inner" | "left">

type Embed<TTables extends Tables, TName extends string, TResource extends string, Inner extends string> =
  string extends keyof TTables
    ? unknown
    : ResourceName<TResource> extends infer Target extends string
      ? Target extends keyof TTables
        ? Shape<
            Cardinality<TTables, TName, Target, ColumnHint<TResource>>,
            SelectRow<TTables, Target, Inner>,
            "inner" extends Modifiers<TResource> ? true : false,
            `'${TName}' has no relationship to '${Target}'`
          >
        : SelectError<`'${Target}' is not a table`>
      : never

type Shape<TKind, TRow, TInner extends boolean, TMessage extends string> =
  TKind extends "one" ? (TInner extends true ? TRow : TRow | null)
  : TKind extends "many" ? TRow[]
  : SelectError<TMessage>

type RowOf<TTables extends Tables, TName extends string> = TTables[TName] extends { Row: infer R } ? R : never

type RelationshipsOf<TDef> =
  TDef extends { Relationships: infer R extends readonly unknown[] } ? R[number] : never

/** The relationships of `From` naming `To`, narrowed to the hinted column when there is one. */
type Referencing<TTables extends Tables, From extends string, To extends string, Hint> = Extract<
  RelationshipsOf<TTables[From]>,
  [Hint] extends [never]
    ? { referencedRelation: To }
    : { referencedRelation: To; columns: readonly [Hint & string, ...string[]] }
>

/** A table holding foreign keys to both sides: the junction of a many-to-many. */
type Junction<TTables extends Tables, From extends string, To extends string> = {
  [J in keyof TTables & string]: [Referencing<TTables, J, From, never>] extends [never]
    ? never
    : [Referencing<TTables, J, To, never>] extends [never]
      ? never
      : J
}[keyof TTables & string]

/**
 * How many rows an embed returns. The key on this side is to-one; the key on the other side is
 * to-many unless it is unique; a junction holding keys to both is to-many.
 */
type Cardinality<TTables extends Tables, From extends string, To extends string, Hint> =
  [Referencing<TTables, From, To, Hint>] extends [never]
    ? [Referencing<TTables, To, From, Hint>] extends [never]
      ? [Junction<TTables, From, To>] extends [never] ? "none" : "many"
      : Referencing<TTables, To, From, Hint> extends { isOneToOne: true } ? "one" : "many"
    : "one"
