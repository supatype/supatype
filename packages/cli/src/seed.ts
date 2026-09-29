/**
 * What a project's seed file imports.
 *
 * Two contracts live here. `sql()` is the old one: the author opens a connection, writes
 * statements and closes it. It is unchanged and still supported, because every existing
 * project uses it.
 *
 * The rest is the new one. A seed exports a function, the runner hands it a `db` typed from
 * the project's schema, and the calls it makes are **collected, not executed**: they become
 * a seed IR document that the engine validates, orders, batches and runs in one
 * transaction.
 *
 * **Nothing here connects to a database, and nothing here builds SQL.** That is the point of
 * the split: the hard parts, ordering a foreign-key graph, batching, mapping a Postgres
 * error back to the schema, are written once in the engine rather than once per language.
 * This file is the part that has to exist per language, and it is deliberately small enough
 * to be worth writing seven times.
 */

import pg from "pg"

export interface SeedSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<pg.QueryResult>
  end(): Promise<void>
}

/** Lightweight tagged-template SQL helper for project `seed.ts` scripts. */
export function sql(connectionString: string): SeedSql {
  const client = new pg.Client({ connectionString })
  let connected = false

  const ensureConnected = async (): Promise<void> => {
    if (!connected) {
      await client.connect()
      connected = true
    }
  }

  const tag = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<pg.QueryResult> => {
    await ensureConnected()
    let text = ""
    for (let i = 0; i < strings.length; i++) {
      text += strings[i]
      if (i < values.length) {
        text += `$${i + 1}`
      }
    }
    return client.query(text, values)
  }

  return Object.assign(tag, {
    end: async (): Promise<void> => {
      if (connected) {
        await client.end()
        connected = false
      }
    },
  })
}

// --- The expression language ---

/**
 * A value the database computes, rather than one the seed hardcodes.
 *
 * The same operand set the schema's access rules use, serialised the same way. Not a second
 * vocabulary: forking one for seeds would need a second validator and a second SQL
 * renderer, and would re-litigate decisions the engine has already made and documented.
 */
export type Operand<C extends string = string> =
  | { kind: "literal"; value: LiteralValue }
  | { kind: "column"; name: C }
  | { kind: "now" }
  | { kind: "startOf"; unit: TruncUnit }
  | { kind: "ago"; amount: number; unit: TimeUnit }
  | { kind: "fromNow"; amount: number; unit: TimeUnit }
  | { kind: "after"; base: Operand<C>; interval: IntervalSpec }
  | { kind: "before"; base: Operand<C>; interval: IntervalSpec }

export type LiteralValue = string | number | boolean

export type TruncUnit = "day" | "week" | "month" | "year"

export type TimeUnit = "seconds" | "minutes" | "hours" | "days" | "weeks" | "months" | "years"

/**
 * A span of time, in any combination of units.
 *
 * Multi-unit because a fixture calendar wants "thirty days from now at 09:00", which a
 * single `{ amount, unit }` cannot say. Components are non-negative: the direction lives in
 * the operand's name, so that `ago` reads as itself rather than as a double negative.
 */
export interface IntervalSpec {
  years?: number
  months?: number
  weeks?: number
  days?: number
  hours?: number
  minutes?: number
  seconds?: number
}

/**
 * A time the database evaluates.
 *
 * Its own type so a generated builder can accept it on date-like columns and nowhere else:
 * `expr.now()` assigned to a title does not compile.
 */
export type TimeExpr = Extract<
  Operand,
  { kind: "now" | "startOf" | "ago" | "fromNow" | "after" | "before" }
>

/**
 * The column's own default.
 *
 * Distinct from leaving the field out. Omission means "do not write this column", which on
 * the update half of an upsert keeps the existing value; this means "put it back to the
 * default". Both are wanted and only one can be spelled by absence.
 */
export interface DefaultExpr {
  readonly $default: true
}

const DEFAULT_EXPR: DefaultExpr = { $default: true }

const INTERVAL_UNITS = [
  "years",
  "months",
  "weeks",
  "days",
  "hours",
  "minutes",
  "seconds",
] as const

/**
 * Drop the units nobody asked for, so two equal intervals serialise the same way.
 *
 * A negative or fractional component is refused rather than carried. The engine's interval
 * components are whole and unsigned, so one that is not fails to read as an operand, falls
 * through to being a plain value, and reaches the database as JSON text in a date column.
 * That surfaced as `invalid input syntax for type timestamp with time zone`, naming neither
 * the field nor the real mistake. Here it names both, at the call that made it.
 */
function interval(spec: IntervalSpec): IntervalSpec {
  const out: IntervalSpec = {}
  for (const unit of INTERVAL_UNITS) {
    const value = spec[unit]
    if (value === undefined || value === 0) continue
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(
        `An interval's \`${unit}\` must be a whole number and not negative, and this is ${value}. ` +
          "The direction is in the name: use `ago` or `before` to go backwards.",
      )
    }
    out[unit] = value
  }
  return out
}

function shifted(base: Operand, spec: IntervalSpec | undefined, ahead: boolean): TimeExpr {
  if (spec === undefined) return base as TimeExpr
  const amount = interval(spec)
  if (Object.keys(amount).length === 0) return base as TimeExpr
  return ahead
    ? { kind: "after", base, interval: amount }
    : { kind: "before", base, interval: amount }
}

/**
 * Values the database computes.
 *
 * Deliberately database-side rather than computed here. A client-computed `daysFromNow(30)`
 * produces a different instant on every run, so a builder emitting it could never reproduce
 * a checked-in fixture; and one IR applied to several environments at different times would
 * give every one of them the same hardcoded instant, which for a fixture calendar is never
 * what people mean.
 */
export const expr = {
  /** `now()`, optionally shifted forward. */
  now(after?: IntervalSpec): TimeExpr {
    return shifted({ kind: "now" }, after, true)
  },
  /** `now()` shifted back. */
  ago(before: IntervalSpec): TimeExpr {
    return shifted({ kind: "now" }, before, false)
  },
  /** The start of the current day, week, month or year, optionally shifted forward. */
  startOf(unit: TruncUnit, after?: IntervalSpec): TimeExpr {
    return shifted({ kind: "startOf", unit }, after, true)
  },
  /** The start of a period, shifted back. */
  startOfBefore(unit: TruncUnit, amount: IntervalSpec): TimeExpr {
    return shifted({ kind: "startOf", unit }, amount, false)
  },
  /** The column's own default. */
  default(): DefaultExpr {
    return DEFAULT_EXPR
  },
} as const

// --- Predicates ---

export type CompareOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like"

/**
 * A condition on rows, in the schema's own rule language.
 *
 * The engine already parses, validates and compiles this tree for every RLS policy it
 * writes, so a seed condition is that tree scoped to a model rather than anything new. A
 * person who has written `Eq<"status", Literal<"published">>` in their schema already knows
 * this language.
 */
export type Predicate<C extends string = string> =
  | { type: "compare"; left: Operand<C>; op: CompareOp; right: Operand<C> }
  | { type: "any"; rules: Predicate<C>[] }
  | { type: "all"; rules: Predicate<C>[] }
  | { type: "not"; rule: Predicate<C> }
  | { type: "nullCheck"; operand: Operand<C>; isNull: boolean }
  | { type: "in"; column: C; source: { kind: "literal"; values: LiteralValue[] } }

function compare<C extends string>(column: C, op: CompareOp, value: LiteralValue): Predicate<C> {
  return {
    type: "compare",
    left: { kind: "column", name: column },
    op,
    right: { kind: "literal", value },
  }
}

export const eq = <C extends string>(column: C, value: LiteralValue): Predicate<C> =>
  compare(column, "eq", value)
export const neq = <C extends string>(column: C, value: LiteralValue): Predicate<C> =>
  compare(column, "neq", value)
export const gt = <C extends string>(column: C, value: LiteralValue): Predicate<C> =>
  compare(column, "gt", value)
export const gte = <C extends string>(column: C, value: LiteralValue): Predicate<C> =>
  compare(column, "gte", value)
export const lt = <C extends string>(column: C, value: LiteralValue): Predicate<C> =>
  compare(column, "lt", value)
export const lte = <C extends string>(column: C, value: LiteralValue): Predicate<C> =>
  compare(column, "lte", value)
export const like = <C extends string>(column: C, pattern: string): Predicate<C> =>
  compare(column, "like", pattern)

export const isNull = <C extends string>(column: C): Predicate<C> => ({
  type: "nullCheck",
  operand: { kind: "column", name: column },
  isNull: true,
})
export const notNull = <C extends string>(column: C): Predicate<C> => ({
  type: "nullCheck",
  operand: { kind: "column", name: column },
  isNull: false,
})

/** Every rule must hold. */
export const and = <C extends string>(...rules: Predicate<C>[]): Predicate<C> => ({
  type: "all",
  rules,
})

/** Any one rule holding is enough. */
export const or = <C extends string>(...rules: Predicate<C>[]): Predicate<C> => ({
  type: "any",
  rules,
})

export const not = <C extends string>(rule: Predicate<C>): Predicate<C> => ({ type: "not", rule })

/**
 * The column's value is one of these.
 *
 * `oneOf` rather than `in`, which is a reserved word and cannot be an identifier.
 */
export const oneOf = <C extends string>(
  column: C,
  values: readonly LiteralValue[],
): Predicate<C> => ({
  type: "in",
  column,
  source: { kind: "literal", values: [...values] },
})

// --- The document a builder produces ---

/** A value produced by an earlier operation in the same document. */
export interface RefValue {
  readonly $ref: string
}

/** An exact decimal, kept as text because JSON has no decimal type. */
export interface NumericValue {
  readonly $numeric: string
}

export type SeedValue =
  | string
  | number
  | boolean
  | null
  | readonly SeedValue[]
  | RefValue
  | NumericValue
  | DefaultExpr
  | Operand
  | { readonly [key: string]: SeedValue | undefined }

export type SeedData = Record<string, SeedValue>

export type SeedOperation =
  | { op: "create"; model: string; id?: string; data: SeedData }
  | { op: "createMany"; model: string; rows: SeedData[] }
  | { op: "upsert"; model: string; id?: string; where: SeedData; data: SeedData }
  | { op: "sql"; text: string; params?: SeedValue[] }
  | { op: "group"; if?: SeedCondition; operations: SeedOperation[] }

export type SeedCondition =
  | { kind: "exists"; model: string; where?: Predicate }
  | { kind: "notExists"; model: string; where?: Predicate }
  | { kind: "environment"; name: string }

/** One seed document, as the engine reads it. */
export interface SeedIr {
  irVersion: 1
  schemaFingerprint: string
  operations: SeedOperation[]
}

// --- What a generated builder plugs into ---

/**
 * What the runtime needs to know about a model and cannot tell from a value.
 *
 * Written by the generator, read by the collector. Three facts, each of which changes how a
 * value is encoded and none of which is visible at runtime: which columns are exact
 * decimals, which hold a time, and which fields are relations to what.
 */
export interface ModelManifest {
  model: string
  table: string
  /** Columns where a number would lose precision, so the value travels as an exact decimal. */
  numeric: readonly string[]
  /** Columns that hold an instant, so a `Date` is rendered as one. */
  temporal: readonly string[]
  relations: Readonly<Record<string, { kind: RelationKind; target: string }>>
}

export type RelationKind = "belongsTo" | "hasOne" | "hasMany" | "manyToMany"

/** What a model exposes on `db`. */
export interface ModelApi<TCreate, TWhere, TRef> {
  /** Insert one row, and hand back something later operations can point at. */
  create(data: TCreate, options?: { id?: string }): TRef
  /**
   * Insert many rows of one model in one statement.
   *
   * Not sugar for repeated `create`: a per-row API is how a seed of a few thousand rows
   * becomes a few thousand round trips.
   */
  createMany(rows: readonly TCreate[]): void
  /**
   * Insert, or update the row the `where` columns already identify.
   *
   * The primary operation for a seed, because seeds get re-run and idempotency is the thing
   * every hand-written one gets wrong.
   */
  upsert(args: { where: TWhere; data: TCreate; id?: string }): TRef
}

/**
 * Filled in by the generated builder, through declaration merging.
 *
 * Empty here so the runtime compiles on its own, and so a project that has not run
 * `supatype generate` yet gets a loosely typed `db` rather than a module that does not
 * resolve.
 */
export interface SupatypeSeedRegistry {
  /** Never set. Present so the interface is not empty, which some lint rules refuse. */
  readonly __generated?: never
}

type FallbackModel = ModelApi<SeedData, SeedData, Record<string, RefValue>>

type RegisteredModels = SupatypeSeedRegistry extends { models: infer M }
  ? M
  : Record<string, FallbackModel>

type RegisteredCondition = SupatypeSeedRegistry extends { condition: infer C }
  ? C
  : SeedConditionInput

/** The condition surface, before a generated builder narrows it to this schema's models. */
export type SeedConditionInput =
  | { exists: { model: string; where?: Predicate } }
  | { notExists: { model: string; where?: Predicate } }
  | { environment: string }

export type SeedDb = RegisteredModels & {
  /**
   * Run a block only when the database says so.
   *
   * Plain `if` already works for anything decided from the program's own inputs, and should
   * be preferred. This is for the one thing plain `if` cannot do: branch on database state,
   * which the builder cannot read because it never connects. The condition travels in the
   * IR and the engine evaluates it at this position, inside the transaction.
   */
  $if(condition: RegisteredCondition, body: () => void): void
  /**
   * A raw statement, in the same transaction and the same order as everything else.
   *
   * Inside the IR rather than offered as a side channel, so a seed that mixes typed
   * operations and raw SQL still runs as one thing instead of the author opening a second
   * connection the engine knows nothing about.
   */
  $sql(text: string, params?: readonly SeedValue[]): void
}

/** What the runner hands a seed's default export. */
export interface SeedContext {
  db: SeedDb
  expr: typeof expr
  /** Print a line, through the runner's own output rather than straight to stdout. */
  log: (message: string) => void
  /** The environment this run targets, when the runner was told one. */
  environment?: string | undefined
}

/** What a seed file may ask of the runner. */
export interface SeedConfig {
  /** Run this document in a transaction. Default true, and rarely worth changing. */
  transaction?: boolean
  /**
   * Apply this document at most once per environment.
   *
   * For a genuine one-time backfill rather than a fixture. Off by default, because seeds
   * are idempotent upserts by design and skipping one because it ran before would turn
   * every seed file into a one-shot migration.
   */
  runOnce?: boolean
}

/** The shape a seed module exports. */
export interface SeedModule {
  default?: (context: SeedContext) => void | Promise<void>
  config?: SeedConfig
}
