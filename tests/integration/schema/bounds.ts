import type {
  Any,
  Between,
  Blocks,
  Block,
  DateOnly,
  Int,
  JSON,
  MaxItems,
  MaxLength,
  MinItems,
  MinLength,
  ItemCount,
  Length,
  Literal,
  Gte,
  Lte,
  Matches,
  Model,
  NotNull,
  Optional,
  Public,
  RichText,
  Role,
  UUID,
} from "@supatype/types"

type NoteBlock = Block<"note", { text: string }>

/**
 * Every bound modifier, declared once so the integration push produces an `admin-config.json` that
 * exercises all of them.
 *
 * It exists to be *generated*, not written to. Studio's parity check reads the admin config this
 * push produces and requires the validator to implement every `validation` key the engine emitted;
 * without a model declaring them, that check passes by having nothing to check.
 *
 * A separate model rather than bounds added to `page` or `post`: those are seeded and written by the
 * soak, so a bound placed on one is a way to break a job that has nothing to do with validation.
 * Nothing writes to this table, and every field is optional, so an absent value is always legal.
 *
 * The bounds are deliberately loose. Enforcement is proven in the engine's
 * `field_bounds_enforcement_tests` against real data; the only job here is to make each measure
 * appear in the generated config.
 */
export type boundsProbe = Model<{
  id: UUID
  /** length, both ends */
  headline: Optional<MinLength<MaxLength<string, 500>, 1>>
  /** length over a lexical document, measured as plain text */
  body: Optional<MaxLength<RichText, 100000>>
  /** items over a real array */
  tags: Optional<MaxItems<string[], 100>>
  /** items over a JSON array */
  refs: Optional<MinItems<JSON<{ id: string }[]>, 1>>
  /** items over blocks */
  sections: Optional<MaxItems<Blocks<NoteBlock>, 100>>
  /** range over a number */
  rating: Optional<Between<Int, 0, 1000>>
  /** range over a date, which takes ISO-8601 literals rather than numbers */
  observedOn: Optional<Between<DateOnly, "2000-01-01", "2100-01-01">>
  /** cross-column, which no field modifier can express */
  windowOpens: Optional<DateOnly>
  windowCloses: Optional<DateOnly>
  /** a pattern */
  reference: Optional<string>
}, {
  // A declared index, so the generated admin config carries one and Studio's Rules tab has
  // something real to render. Composite and on nullable columns, which is the shape most likely to
  // expose a rendering assumption.
  indexes: [{ fields: ["windowOpens", "reference"] }]
  // Model-level rules, so the integration push produces an admin config carrying constraint nodes.
  // Studio's parity check walks them; without these it would pass by having nothing to walk.
  constraints: [
    Lte<"windowOpens", "windowCloses">,
    Matches<"reference", "^[A-Z]{2}-[0-9]{4}$">,
    Gte<ItemCount<"tags">, Literal<0>>,
    Lte<Length<"headline">, Literal<500>>,
    Any<[NotNull<"headline">, NotNull<"reference">]>,
  ]
  access: {
    read: Public
    create: Role<"service_role">
    update: Role<"service_role">
    delete: Role<"service_role">
  }
}>
