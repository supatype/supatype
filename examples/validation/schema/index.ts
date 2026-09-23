import type {
  Any,
  Between,
  Block,
  Blocks,
  DateOnly,
  Eq,
  Gte,
  Int,
  ItemCount,
  JSON,
  LocaleConfig,
  Length,
  Literal,
  Localized,
  LoggedIn,
  Lte,
  Matches,
  MaxItems,
  MaxLength,
  MinItems,
  MinLength,
  Model,
  NotNull,
  Optional,
  Public,
  RichText,
  Role,
  Slug,
  Unique,
  UUID,
  WithTimestamps,
} from "@supatype/types"

/**
 * Every layer of field validation, in one schema.
 *
 * Three mechanisms, and the point of the example is that they are *different*, not interchangeable:
 *
 * 1. **Bounds** on a field's type compile to a column `CHECK`. One column, one measure.
 * 2. **Constraints** on the model compile to a table `CHECK`. Cross-column rules, patterns, and
 *    anything the bound modifiers cannot say.
 * 3. **Validators** run an edge function before the write. For what a database cannot express at
 *    all, and the only one whose refusal names a field back to the caller.
 *
 * The first two hold for **every** writer, including direct SQL and seeds. The third runs on the API
 * write path only, so anything expressible as one of the first two should be.
 */

/**
 * Two locales, so the localized bound has something to be per.
 *
 * A localized field is stored as one JSONB object keyed by locale, so `char_length(headline)` would
 * measure the JSON envelope rather than the copy. The engine compiles the bound to a helper that
 * measures each locale's value instead, which is why this declaration changes the SQL and not just
 * the editor.
 */
export type Locales = LocaleConfig<["en", "fr"], "en">

type SetupItem = { label: string; minutes: number }

type NoteBlock = Block<"note", { text: string }>

export type Product = Model<WithTimestamps<{
  id: UUID

  // ── Bounds: one column, one measure ──────────────────────────────────────────
  /** Characters. Studio caps the input and shows a counter; Postgres holds `char_length(…) <= 80`. */
  name: MinLength<MaxLength<string, 80>, 3>
  slug: Optional<Unique<Slug<"name">>>
  /** Plain-text characters of a lexical document, measured through a managed helper function. */
  description: Optional<MaxLength<RichText, 2000>>
  /** Elements, not characters. `MaxLength` here is a push-time error naming `MaxItems`. */
  tags: Optional<MaxItems<string[], 8>>
  /** A JSON array: elements again, and the check is guarded so an object cannot slip through. */
  setupItems: Optional<MinItems<JSON<SetupItem[]>, 1>>
  /** Blocks are counted, so "a product needs at least one note" is a bound rather than prose. */
  notes: Optional<MinItems<Blocks<NoteBlock>, 1>>
  /** A numeric range, compared directly with no cast. */
  rating: Optional<Between<Int, 1, 5>>
  /** A temporal range, compiled to the column's own type rather than to `numeric`. */
  availableFrom: Optional<Between<DateOnly, "2020-01-01", "2100-01-01">>
  availableUntil: Optional<DateOnly>

  /** Localized: the bound applies per locale, which a scalar expression could not do. */
  headline: Optional<Localized<MaxLength<string, 60>>>

  sku: Optional<string>
  status: "draft" | "published"
}>, {
  access: {
    read: Public
    create: LoggedIn
    update: LoggedIn
    delete: Role<"service_role">
  }

  // ── Constraints: the model, not the field ────────────────────────────────────
  constraints: [
    /** Cross-column: no field modifier can compare two columns. */
    Lte<"availableFrom", "availableUntil">,
    /** A pattern, never a predicate: there is nothing here to escape out of. */
    Matches<"sku", "^[A-Z]{3}-[0-9]{4}$">,
    /** A measure in expression position, resolved to `jsonb_array_length` by the field's kind. */
    Lte<ItemCount<"setupItems">, Literal<20>>,
    /** And in the other unit, over text. */
    Gte<Length<"name">, Literal<3>>,
    /** A combinator: published products must carry a SKU. */
    Any<[Eq<"status", Literal<"draft">>, NotNull<"sku">]>,
  ]

  // ── Indexes: not a rule, but the other thing the Rules tab lists ─────────────
  //
  // An index changes no answer, only how long it takes to get one, which is exactly why it is
  // invisible until a table is large enough to hurt. Declaring them here puts them somewhere a
  // reader can find without opening psql.
  indexes: [
    /** Named, because a composite index is the one you go looking for by name in a plan. */
    { name: "product_status_created_idx", fields: ["status", "created_at"] },
    /**
     * Unnamed and unique: the engine derives `product_sku_idx`, which is the name Postgres will
     * carry, and `unique` makes it a constraint as well as an index.
     *
     * Not declared on `slug`, which `Unique<Slug<"name">>` already indexes: a second unique index
     * over the same column costs a write for nothing.
     */
    { fields: ["sku"], unique: true },
  ]

  // ── Validator: what the database cannot express ──────────────────────────────
  //
  // Total setup time is a rule about the *contents* of a JSON array, summed. That is not a bound and
  // not a comparison, and its refusal names `setupItems` so Studio puts the message on that input.
  validate: { setupItems: "validate-setup-items" }
}>
