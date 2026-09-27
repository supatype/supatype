/**
 * Every field kind, and what each one must do on a real database.
 *
 * # Why this exists
 *
 * Coverage of *kinds* was already 32 of 41, and every engine defect found in the week this was
 * written was in a **property** of a kind that was already covered:
 *
 *   - `money` published `pgType: "TEXT"` for a `NUMERIC(19,4)` column
 *   - `RelatedTo<X, { required: true }>` generated `x_id: string | null` over a NOT NULL column
 *   - an enum with a default was emitted as required on `Insert`
 *   - a field could not be *removed* from a model with a draft view
 *   - a second push with no change proposed the same two operations forever
 *
 * None of those is about which kinds exist. They are about what each kind promises: the column it
 * creates, the type it publishes, the type it generates, whether a value survives a round trip,
 * whether pushing twice is a no-op, and whether it can be taken away again.
 *
 * # Exhaustive on purpose
 *
 * Typed `Record<FieldKind, KindSpec>`, so a kind added to `FIELD_KINDS` fails the build until it is
 * classified here. `BOUNDS_BY_KIND` in the CLI uses the same device, and `FIELD_KINDS`' own comment
 * names it as the reason that list exists: nine kinds once accepted a declared bound and enforced
 * nothing, because no code anywhere could ask "what are all the kinds".
 *
 * Classifying a kind as {@link Unreachable} is a claim, not an escape: the harness asserts that the
 * extractor really cannot produce it, so a kind marked unreachable that later becomes reachable
 * fails rather than silently going untested.
 */
import type { FieldKind } from "../../../packages/cli/src/schema-ast-v2.js"

/** A kind the public type API can declare, and what it must do. */
export interface Testable {
  readonly form: "testable"
  /** The type expression as written in a schema, e.g. `Optional<Money>`. */
  readonly declare: string
  /** Named type imports the declaration needs from `@supatype/types`. */
  readonly imports: readonly string[]
  /** `information_schema.columns.data_type` the column must have. */
  readonly pgDataType: string
  /** `udt_name`, when `data_type` alone does not pin it (USER-DEFINED). */
  readonly pgUdtName?: string
  /** A value written and read back through the REST API. */
  readonly sample: unknown
  /**
   * Compared with the value the API returns, when reading it back is not identity.
   *
   * Postgres normalises plenty: `NUMERIC` gains trailing zeros, `TSVECTOR` is rewritten in lexeme
   * order, a `GEOGRAPHY` comes back as WKB. Where that is expected, say so here rather than
   * loosening the assertion for every kind.
   */
  readonly expect?: (returned: unknown) => boolean
}

/** A kind no public type can produce, with the evidence. */
export interface Unreachable {
  readonly form: "unreachable"
  /** Why nothing can declare it, checked by the harness rather than trusted. */
  readonly reason: string
}

/**
 * A kind that is declarable but needs scaffolding this harness does not yet build.
 *
 * Its own form rather than an omission, so the run reports it. A kind quietly left out of a
 * coverage harness is indistinguishable from one that passes.
 */
export interface Deferred {
  readonly form: "deferred"
  /** What it needs, so the next person knows what to add rather than why it is absent. */
  readonly needs: string
}

/** A kind that expands into other columns rather than being one. */
export interface Composite {
  readonly form: "composite"
  /** The declaration that expands it, e.g. `WithTimestamps<...>`. */
  readonly declare: string
  /** Columns it must produce. */
  readonly expands: readonly string[]
}

export type KindSpec = Testable | Unreachable | Deferred | Composite

const t = (
  declare: string,
  imports: readonly string[],
  pgDataType: string,
  sample: unknown,
  extra: Partial<Pick<Testable, "pgUdtName" | "expect">> = {},
): Testable => ({ form: "testable", declare, imports, pgDataType, sample, ...extra })

/** Numeric columns come back with the scale Postgres stores, so compare numerically. */
const numeric = (want: number) => (got: unknown) => Number(got) === want

/**
 * Every digit that was sent came back, and nothing was routed through a double on the way.
 *
 * Deliberately not `numeric`. That one coerces with `Number()` before comparing, which is the
 * precise rounding `bigInt`, `decimal` and `money` exist to avoid, so it agrees with a value that
 * has already been corrupted. An assertion that launders the defect it is checking for is worse
 * than no assertion, because it reports success.
 *
 * A bare `number` is rejected outright: for these kinds it means the digits were already lost
 * before this comparison ran, whatever the value now says.
 *
 * Scale is normalised rather than matched textually, because Postgres returns a NUMERIC with the
 * scale the column declares: `10.00` into `NUMERIC(19,4)` comes back `10.0000`, which is the same
 * value and not a defect. Written here rather than imported from the client so that a bug in the
 * client's own normaliser cannot hide itself by being used to grade its own work.
 */
const exact = (want: string) => (got: unknown) => {
  if (typeof got === "bigint") return got.toString() === trimScale(want)
  if (typeof got !== "string") return false
  return trimScale(got) === trimScale(want)
}

/** A decimal string with insignificant trailing zeros removed, so `10.0000` equals `10.00`. */
const trimScale = (value: string): string => {
  if (!value.includes(".")) return value
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "")
  return trimmed === "" || trimmed === "-" ? "0" : trimmed
}

/** Same instant, whatever offset notation the driver renders it in. */
const sameInstant = (want: string) => (got: unknown) =>
  typeof got === "string" && new Date(got).getTime() === new Date(want).getTime()

/** Same object, whatever order the keys come back in. */
const sameShape = (want: unknown) => (got: unknown) =>
  JSON.stringify(sortKeys(got)) === JSON.stringify(sortKeys(want))

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortKeys(v)]),
  )
}

export const KIND_SPECS: Record<FieldKind, KindSpec> = {
  // ── Text-shaped ───────────────────────────────────────────────────────────
  text: t("Optional<string>", [], "text", "a string"),
  email: t("Optional<Email>", ["Email"], "text", "conformance@example.com"),
  url: t("Optional<URL>", ["URL"], "text", "https://example.com/a"),
  slug: t("Optional<Slug<\"probeText\">>", ["Slug"], "text", "a-string"),
  color: t("Optional<Color>", ["Color"], "text", "#3b82f6"),
  xml: t("Optional<XML>", ["XML"], "xml", "<a>b</a>"),
  ip: t("Optional<IPAddress>", ["IPAddress"], "inet", "192.168.0.1"),
  cidr: t("Optional<CIDR>", ["CIDR"], "cidr", "192.168.0.0/24"),
  macaddr: t("Optional<MacAddress>", ["MacAddress"], "macaddr", "08:00:2b:01:02:03"),
  // Postgres rewrites a tsquery into its lexemes, so `cat & dog` comes back `'cat' & 'dog'`.
  // Normalisation, not loss.
  tsQuery: t("Optional<TSQuery>", ["TSQuery"], "tsquery", "cat & dog", {
    expect: (got) => typeof got === "string" && got.includes("cat") && got.includes("dog"),
  }),
  tsVector: t("Optional<TSVector>", ["TSVector"], "tsvector", "cat dog", {
    expect: (got) => typeof got === "string" && got.includes("cat") && got.includes("dog"),
  }),
  richText: t("Optional<RichText>", ["RichText"], "jsonb", { root: {} }),
  bytes: t("Optional<Bytea>", ["Bytea"], "bytea", "\\x00ff"),

  // ── Numeric ───────────────────────────────────────────────────────────────
  integer: t("Optional<Int>", ["Int"], "integer", 42),
  smallInt: t("Optional<SmallInt>", ["SmallInt"], "smallint", 7),
  // One past 2^53, so a double cannot hold it and a round trip through one is visible.
  bigInt: t("Optional<BigInt>", ["BigInt"], "bigint", "9007199254740993", {
    expect: exact("9007199254740993"),
  }),
  float: t("Optional<Float>", ["Float"], "double precision", 1.5),
  serial: { form: "deferred", needs: "an AutoIncrement column is server-generated, so the round trip and the drop both need their own shape" },
  bigSerial: { form: "deferred", needs: "same as serial" },
  // The pair that started this. `Decimal` was already right; `money` said TEXT while the column was
  // NUMERIC(19,4), so a consumer generated a parser that rejected every value it returns.
  //
  // Both now carry a value no double can hold, and are compared with `exact` rather than `numeric`.
  // They passed for months on `1.250` and `10.00` against `numeric(…)`, which is two failures at
  // once: the samples were small enough to survive a round trip through a double, and the
  // comparator coerced with `Number()` before comparing, so it could not have failed even on a
  // sample that did not survive. A suite that cannot fail is not evidence.
  decimal: t("Optional<Decimal<30, 10>>", ["Decimal"], "numeric", "12345678901234567890.1234567890", {
    expect: exact("12345678901234567890.1234567890"),
  }),
  money: t("Optional<Money>", ["Money"], "numeric", "12345678901234.5678", {
    expect: exact("12345678901234.5678"),
  }),

  // ── Temporal ──────────────────────────────────────────────────────────────
  datetime: t("Optional<DateTime>", ["DateTime"], "timestamp with time zone", "2026-01-02T03:04:05.000Z", {
    expect: sameInstant("2026-01-02T03:04:05.000Z"),
  }),
  date: t("Optional<DateOnly>", ["DateOnly"], "date", "2026-01-02"),
  timestamp: {
    form: "unreachable",
    reason:
      "`Timestamp` from @supatype/types maps to kind `datetime`, not `timestamp`: the extractor's " +
      "primitive switch returns scalar(\"datetime\") for Date, DateTime and Timestamp alike. " +
      "Nothing can produce this kind, yet FIELD_KINDS declares it and the engine carries a " +
      "default_pg_type for it.",
  },
  interval: {
    form: "unreachable",
    reason:
      "No `Interval` type is exported from @supatype/types and the extractor never emits this " +
      "kind. It has a bounds form in field-bounds.ts and a pg type in the engine, for a kind no " +
      "schema can declare.",
  },

  // ── Collections and structured values ─────────────────────────────────────
  array: t("Optional<string[]>", [], "ARRAY", ["a", "b"]),
  json: t("Optional<JSON<{ a: number }>>", ["JSON"], "jsonb", { a: 1 }),
  blocks: t("Optional<Blocks>", ["Blocks"], "jsonb", []),
  button: t("Optional<Button>", ["Button"], "jsonb", { label: "Go", href: "/x" }, {
    expect: sameShape({ label: "Go", href: "/x" }),
  }),
  enum: t("Optional<\"one\" | \"two\">", [], "text", "one"),

  // ── Fixed-shape scalars ───────────────────────────────────────────────────
  boolean: t("Optional<boolean>", [], "boolean", true),
  uuid: t("Optional<UUID>", ["UUID"], "uuid", "00000000-0000-4000-8000-000000000001"),

  // ── Storage, spatial, plugin ──────────────────────────────────────────────
  image: { form: "deferred", needs: "a declared storage bucket to reference" },
  file: { form: "deferred", needs: "a declared storage bucket to reference" },
  geo: { form: "deferred", needs: "postgis, which is not guaranteed on every image this runs against" },
  vector: { form: "deferred", needs: "pgvector, same reason as geo" },
  relation: t("Optional<RelatedTo<probeTarget>>", ["RelatedTo"], "uuid", null),
  custom: {
    form: "unreachable",
    reason:
      "Produced only by a plugin field, which needs a plugin registered in supatype.config.ts. " +
      "Covered by the plugin suites rather than here; a schema alone cannot declare one.",
  },

  // ── Composites, expanded into real columns ────────────────────────────────
  timestamps: { form: "composite", declare: "WithTimestamps", expands: ["created_at", "updated_at"] },
  publishable: { form: "composite", declare: "WithPublishable", expands: ["published_at"] },
  softDelete: { form: "composite", declare: "WithSoftDelete", expands: ["deleted_at"] },
}

/** The kinds the harness declares and pushes. */
export function testableKinds(): [FieldKind, Testable][] {
  return Object.entries(KIND_SPECS).filter(
    (e): e is [FieldKind, Testable] => e[1].form === "testable",
  )
}

/** The kinds claimed to be undeclarable, which the harness checks rather than trusts. */
export function unreachableKinds(): [FieldKind, Unreachable][] {
  return Object.entries(KIND_SPECS).filter(
    (e): e is [FieldKind, Unreachable] => e[1].form === "unreachable",
  )
}

/** Kinds declarable but not yet covered, reported by the harness rather than hidden. */
export function deferredKinds(): [FieldKind, Deferred][] {
  return Object.entries(KIND_SPECS).filter(
    (e): e is [FieldKind, Deferred] => e[1].form === "deferred",
  )
}

export function compositeKinds(): [FieldKind, Composite][] {
  return Object.entries(KIND_SPECS).filter(
    (e): e is [FieldKind, Composite] => e[1].form === "composite",
  )
}
