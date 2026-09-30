/**
 * The TypeScript builder against the golden IR document.
 *
 * `supatype-schema-engine/tests/fixtures/seed_golden_ir.json` is written by hand from the IR
 * specification, not captured from either end. That is what makes this test worth having: it
 * checks the builder against the contract rather than against itself, and the first
 * non-TypeScript builder will be checked against the same file rather than against whatever
 * this one happened to emit.
 *
 * Compared canonically, with every object's keys sorted. The two ends legitimately write
 * keys in different orders, and a byte comparison would fail on that while telling nobody
 * anything about whether the documents mean the same thing.
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { SeedCollector, type Manifest } from "../src/seed-ir.js"
import { eq, expr, type SeedDb, type SeedOperation } from "../src/seed.js"

const here = dirname(fileURLToPath(import.meta.url))

const GOLDEN = resolve(here, "fixtures", "seed_golden_ir.json")

/**
 * The engine's copy of the same file, and the reason a second copy is safe.
 *
 * This used to read the engine's fixture directly across a sibling checkout, which is the right
 * instinct and does not survive CI: this repository is cloned on its own, so the path did not
 * exist and the test had never once run there.
 *
 * So the file is vendored, and both repositories assert this hash. Editing either copy turns its
 * own suite red until the hash is updated, and updating the hash turns the other repository red
 * until its copy follows. Neither can drift quietly, which is the only property the shared path
 * was buying.
 *
 * Engine side: `tests/seed_ir_tests.rs`, same constant.
 */
const GOLDEN_SHA256 = "6ec5e51820868e0e303abe3c5aa57e034ff27c53374998d760d425863e538ea6"

const FINGERPRINT = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

/**
 * The manifest the generated builder would emit for the fixture's schema.
 *
 * Hand-written here so this test covers the collector alone. That the generator produces a
 * manifest matching a real schema is the engine's to prove, and that the two meet is the
 * acceptance app's.
 */
const MANIFEST: Manifest = {
  profile: {
    model: "Profile",
    table: "profile",
    numeric: [],
    temporal: [],
    relations: {},
  },
  organiser: {
    model: "Organiser",
    table: "organiser",
    numeric: [],
    temporal: [],
    relations: {
      owner: { kind: "belongsTo", target: "Profile" },
      events: { kind: "hasMany", target: "Event" },
    },
  },
  event: {
    model: "Event",
    table: "event",
    numeric: [],
    temporal: ["starts_at", "ends_at", "created_at"],
    relations: {
      organiser: { kind: "belongsTo", target: "Organiser" },
      ticket_types: { kind: "hasMany", target: "TicketType" },
    },
  },
  ticket_type: {
    model: "TicketType",
    table: "ticket_type",
    numeric: ["price"],
    temporal: [],
    relations: { event: { kind: "belongsTo", target: "Event" } },
  },
  venue: {
    model: "Venue",
    table: "venue",
    numeric: [],
    temporal: [],
    relations: { organiser: { kind: "belongsTo", target: "Organiser" } },
  },
  _global_site_settings: {
    model: "SiteSettings",
    table: "_global_site_settings",
    numeric: [],
    temporal: [],
    relations: {},
  },
  promo_code: {
    model: "PromoCode",
    table: "promo_code",
    numeric: [],
    temporal: ["valid_until"],
    relations: { event: { kind: "belongsTo", target: "Event" } },
  },
}

/** Sort every object's keys, so key order stops being part of the comparison. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    entries.sort(([a], [b]) => a.localeCompare(b))
    return Object.fromEntries(entries.map(([key, inner]) => [key, canonical(inner)]))
  }
  return value
}

function collector(): SeedCollector {
  return new SeedCollector(FINGERPRINT, MANIFEST)
}

/**
 * The seed a person would write to produce the golden document.
 *
 * Typed loosely on purpose: the generated builder is what supplies the real types, and this
 * test is about what the collector emits rather than about what compiles.
 */
function writeTheGoldenSeed(db: SeedDb): void {
  const models = db as unknown as Record<string, {
    create: (data: Record<string, unknown>, options?: { id?: string }) => Record<string, unknown>
    createMany: (rows: Record<string, unknown>[]) => void
    upsert: (args: {
      where: Record<string, unknown>
      data: Record<string, unknown>
      id?: string
    }) => Record<string, unknown>
  }>

  const alex = models["profile"]!.upsert({
    where: { id: "a0000000-0000-4000-8000-000000000001" },
    data: { display_name: "Alex Rivera", full_name: "Alex Rivera" },
    id: "alex",
  })

  models["organiser"]!.upsert({
    where: { slug: "northern-lights-events" },
    data: {
      name: "Northern Lights Events",
      contact_email: "hello@northernlights.test",
      owner: { connect: { id: alex["id"] } },
      events: {
        create: [
          {
            title: "Southwest Dev Conference",
            status: "published",
            starts_at: expr.startOf("day", { days: 30, hours: 9 }),
            ends_at: expr.startOf("day", { days: 30, hours: 18 }),
            created_at: expr.now(),
            ticket_types: {
              createMany: [
                { name: "Early Bird", price: "75.0000", quantity: 100 },
                { name: "Standard", price: "125.0000", quantity: 250 },
              ],
            },
          },
        ],
      },
    },
    id: "northern",
  })

  const venue = { connect: { slug: "northern-lights-events" } }
  models["venue"]!.createMany([
    {
      name: "The Exchange",
      city: "Bristol",
      capacity: 450,
      country: expr.default(),
      organiser: venue,
    },
    {
      name: "Archway Studios",
      city: "London",
      capacity: 180,
      country: expr.default(),
      organiser: venue,
    },
  ])

  db.$if({ notExists: { model: "SiteSettings" } }, () => {
    models["_global_site_settings"]!.create({
      site_name: "Launch Test Tickets",
      default_currency: "GBP",
    })
  })

  db.$if({ exists: { model: "Event", where: eq("status", "published") } }, () => {
    models["promo_code"]!.create({
      code: "EARLY20",
      discount_kind: "percentage",
      discount_value: 20,
      valid_until: expr.now({ days: 25 }),
      event: { connect: { slug: "southwest-dev-conference" } },
    })
  })

  db.$sql("ANALYZE event")
}

describe("the builder against the golden IR", () => {
  it("reproduces the document the specification describes", () => {
    const collect = collector()
    writeTheGoldenSeed(collect.db())
    const produced = collect.finish().ir

    const golden: unknown = JSON.parse(readFileSync(GOLDEN, "utf8"))
    expect(canonical(produced)).toEqual(canonical(golden))
  })

  it("covers every operation kind, or it is not much of a contract", () => {
    const collect = collector()
    writeTheGoldenSeed(collect.db())

    // Recursively, because two of the five only appear inside a group: a coverage check
    // that looked at the top level alone would pass while missing them.
    const kinds = new Set<string>()
    const walk = (operations: readonly SeedOperation[]): void => {
      for (const operation of operations) {
        kinds.add(operation.op)
        if (operation.op === "group") walk(operation.operations)
      }
    }
    walk(collect.finish().ir.operations)

    expect(kinds).toEqual(new Set(["create", "createMany", "upsert", "group", "sql"]))
  })
})

describe("what the collector encodes", () => {
  it("labels an operation only when something points at it", () => {
    const collect = collector()
    const models = collect.db() as unknown as Record<
      string,
      { create: (data: Record<string, unknown>) => Record<string, unknown> }
    >
    models["profile"]!.create({ display_name: "Unreferenced" })
    const referenced = models["profile"]!.create({ display_name: "Referenced" })
    models["organiser"]!.create({ name: "N", owner: { connect: { id: referenced["id"] } } })

    const operations = collect.finish().ir.operations
    expect(operations[0]).not.toHaveProperty("id")
    expect(operations[1]).toHaveProperty("id")
  })

  /**
   * A decimal column must not round-trip through a double. `0.1 + 0.2` is the reason, and a
   * currency amount is the least acceptable place for it.
   */
  it("sends an exact-decimal column as text and leaves other numbers alone", () => {
    const collect = collector()
    const models = collect.db() as unknown as Record<
      string,
      { create: (data: Record<string, unknown>) => Record<string, unknown> }
    >
    models["ticket_type"]!.create({ name: "Early", price: 75.5, quantity: 100 })

    const operation = collect.finish().ir.operations[0]
    expect(operation).toMatchObject({
      op: "create",
      data: { price: { $numeric: "75.5" }, quantity: 100 },
    })
  })

  it("renders a Date as an instant", () => {
    const collect = collector()
    const models = collect.db() as unknown as Record<
      string,
      { create: (data: Record<string, unknown>) => Record<string, unknown> }
    >
    models["event"]!.create({ title: "Conf", starts_at: new Date("2026-01-01T09:00:00.000Z") })

    expect(collect.finish().ir.operations[0]).toMatchObject({
      data: { starts_at: "2026-01-01T09:00:00.000Z" },
    })
  })

  /** `expr.now()` is already the shape the engine reads, so it must pass through untouched. */
  it("leaves an expression alone rather than encoding it again", () => {
    const collect = collector()
    const models = collect.db() as unknown as Record<
      string,
      { create: (data: Record<string, unknown>) => Record<string, unknown> }
    >
    models["event"]!.create({ title: "Conf", created_at: expr.now() })

    expect(collect.finish().ir.operations[0]).toMatchObject({
      data: { created_at: { kind: "now" } },
    })
  })

  it("collects a group's operations into the group, not beside it", () => {
    const collect = collector()
    const db = collect.db()
    const models = db as unknown as Record<
      string,
      { create: (data: Record<string, unknown>) => Record<string, unknown> }
    >
    db.$if({ notExists: { model: "SiteSettings" } }, () => {
      models["profile"]!.create({ display_name: "Inside" })
    })
    models["profile"]!.create({ display_name: "Outside" })

    const operations = collect.finish().ir.operations
    expect(operations).toHaveLength(2)
    expect(operations[0]).toMatchObject({
      op: "group",
      if: { kind: "notExists", model: "SiteSettings" },
    })
    expect(operations[1]).toMatchObject({ op: "create" })
  })

  /**
   * A seed that throws inside a `$if` must not leave every later call collecting into a
   * block that is never emitted, which would lose them silently.
   */
  it("leaves the block it was collecting into when a group throws", () => {
    const collect = collector()
    const db = collect.db()
    const models = db as unknown as Record<
      string,
      { create: (data: Record<string, unknown>) => Record<string, unknown> }
    >
    expect(() => {
      db.$if({ notExists: { model: "SiteSettings" } }, () => {
        throw new Error("the seed failed")
      })
    }).toThrow("the seed failed")

    models["profile"]!.create({ display_name: "After" })
    const operations = collect.finish().ir.operations
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({ op: "create" })
  })

  it("normalises a hasOne nested create into the list the IR carries", () => {
    const collect = collector()
    const models = collect.db() as unknown as Record<
      string,
      { create: (data: Record<string, unknown>) => Record<string, unknown> }
    >
    models["organiser"]!.create({
      name: "N",
      events: { create: { title: "Only one" } },
    })

    expect(collect.finish().ir.operations[0]).toMatchObject({
      data: { events: { create: [{ title: "Only one" }] } },
    })
  })

  /** A reference is a thenable-looking object, and awaiting one must not hang. */
  it("does not answer to `then`, so a builder call can be awaited harmlessly", async () => {
    const collect = collector()
    const models = collect.db() as unknown as Record<
      string,
      { create: (data: Record<string, unknown>) => Record<string, unknown> }
    >
    const row = models["profile"]!.create({ display_name: "Alex" })
    await expect(Promise.resolve(row)).resolves.toBeDefined()
  })
})

describe("the predicate helpers", () => {
  it("serialise to the rule tree the schema already uses", () => {
    expect(eq("status", "published")).toEqual({
      type: "compare",
      op: "eq",
      left: { kind: "column", name: "status" },
      right: { kind: "literal", value: "published" },
    })
  })
})

describe("the expression helpers", () => {
  it("compose a base and an interval rather than inventing a second vocabulary", () => {
    expect(expr.now()).toEqual({ kind: "now" })
    expect(expr.now({ days: 30 })).toEqual({
      kind: "after",
      base: { kind: "now" },
      interval: { days: 30 },
    })
    expect(expr.startOf("day", { days: 30, hours: 9 })).toEqual({
      kind: "after",
      base: { kind: "startOf", unit: "day" },
      interval: { days: 30, hours: 9 },
    })
    expect(expr.ago({ days: 7 })).toEqual({
      kind: "before",
      base: { kind: "now" },
      interval: { days: 7 },
    })
  })

  /**
   * The engine's interval components are whole and unsigned, so one that is not fails to read
   * as an operand, falls through to being a plain value, and reaches the database as JSON
   * text in a date column. That surfaced as `invalid input syntax for type timestamp with
   * time zone`, naming neither the field nor the real mistake. Refused at the call instead.
   */
  it("refuses a negative or fractional component, where the mistake was made", () => {
    expect(() => expr.now({ days: -20 })).toThrow(/whole number and not negative/)
    expect(() => expr.startOf("day", { hours: 1.5 })).toThrow(/whole number/)
    expect(() => expr.now({ days: -20 })).toThrow(/ago/)
  })

  /** Two equal intervals must serialise identically, or the golden fixture is untestable. */
  it("drops the units nobody asked for", () => {
    expect(expr.now({ days: 30, hours: 0 })).toEqual(expr.now({ days: 30 }))
    expect(expr.now({})).toEqual({ kind: "now" })
  })
})

describe("where the fixture lives", () => {
  it("is the engine's copy, not a second one that can drift", () => {
    expect(GOLDEN).toContain(join("tests", "fixtures"))
    // Line endings normalised first. git hands this file out as CRLF on Windows and LF on
    // Linux, so hashing the bytes as checked out pins the platform rather than the content.
    const normalised = readFileSync(GOLDEN, "utf8").split("\r\n").join("\n")
    const digest = createHash("sha256").update(normalised, "utf8").digest("hex")
    expect(digest, "the vendored copy has drifted from the engine's").toBe(GOLDEN_SHA256)
    expect(() => readFileSync(GOLDEN, "utf8")).not.toThrow()
  })
})
