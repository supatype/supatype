# Seeding reference

A seed describes writes; it does not perform them. Your file builds a document, the engine
validates it against the schema, orders it by foreign key, batches it, and applies it in one
transaction. So there is no connection to open, no ordering to work out, no SQL, and a failure
halfway leaves nothing behind.

Run it with `supatype seed`.

## The contract

```ts
import type { SeedContext } from "@supatype/cli/seed"

export default async function seed({ db, expr, log }: SeedContext) {
  const alex = db.profile.upsert({
    where: { id: "a0000000-0000-4000-8000-000000000001" },
    data: { display_name: "Alex Rivera" },
  })

  db.organiser.upsert({
    where: { slug: "northern-lights-events" },
    data: {
      name: "Northern Lights Events",
      contact_email: "hello@northernlights.test",
      owner: { connect: { id: alex.id } },
    },
  })
}
```

`alex.id` is **not** a value read from the database. It is a reference token that travels in
the document as `{"$ref": "alex.id"}` and is resolved by the engine. The builder is synchronous
and pure: nothing here awaits, and nothing connects.

`db` is typed from your schema by `supatype/generated/seed.ts`, which `supatype generate`
writes. That file is gitignored and rebuilt by the `prepare` script on install, because
`generate` needs no database and no running stack.

| Context | What it is |
|---------|------------|
| `db` | Your models, one property per table |
| `expr` | Values the database computes: `now`, `startOf`, `ago`, `default` |
| `log` | A line through the runner's own output |
| `environment` | The `--environment` name, when one was given |

## Operations

| Call | Becomes |
|------|---------|
| `db.model.create(data, { id? })` | One insert. Returns a reference token |
| `db.model.createMany(rows)` | One statement for all rows, not one per row |
| `db.model.upsert({ where, data, id? })` | Insert, or update the row `where` identifies |
| `db.$if(condition, () => { ... })` | A block the engine runs only if the condition holds |
| `db.$sql(text, params?)` | A raw statement, in the same transaction and the same order |

**Reach for `upsert`.** Seeds get re-run, and a natural key means the row identifies itself
rather than needing an id pasted in. `where` accepts only columns that identify one row: a
primary key, a `Unique<>` column, or a composite index marked `unique: true`. That restriction
is what lets an upsert compile to a correct `ON CONFLICT` target instead of a guess.

If a model has no unique column, its `Where` type is `never` and it cannot be upserted. Give it
a natural key in the schema.

## Relations

| Side | Input |
|------|-------|
| The side holding the foreign key | `{ connect: { slug: "..." } }` |
| The inverse side, one row | `{ create: { ... } }` |
| The inverse side, many | `{ create: [...] }` or `{ createMany: [...] }` |

A nested write fills the child's foreign key for you. `connect` names an existing row by any
unique key: by the referenced column it is used directly, and by another unique key the engine
resolves it inside the same statement rather than in a round trip per row.

Many-to-many relations have no nested write. Their rows live in a junction table; write those
as their own operation.

## Values the database computes

```ts
starts_at: expr.startOf("day", { days: 30, hours: 9 })   // 09:00, thirty days out
ends_at:   expr.now({ days: 30 })                        // thirty days from now
created_at: expr.now()
archived_at: expr.ago({ days: 7 })
country: expr.default()                                  // the column's own default
```

These are evaluated by Postgres at seed time, not by your file. A fixture calendar stays ahead
of whenever it is run rather than being fixed to whenever the file was written, and one document
applied to several environments gives each of them times relative to its own run.

Interval components are whole and not negative: the direction lives in the operand's name, so
use `ago` or `startOfBefore` to go backwards. `expr.now({ days: -20 })` throws, at the call.

`expr.now()` is typed to date-like columns and `expr.default()` to columns that have a default,
so assigning either to the wrong column does not compile.

A rich text column takes a plain string as well as a Lexical document. A trigger normalises
the string into a single-paragraph document on the way in, so fixture prose is written as
prose and a read always returns the document.

**There is no `expr.uuid()`.** Omit `id` and the column's own default fills it. A second way to
say it would let a seed and its schema disagree about how ids are made.

## Conditions

Ordinary control flow already works for anything decided from your program's own inputs:

```ts
if (process.env["NODE_ENV"] === "development") {
  db.event.create({ ... })          // no feature needed
}
```

`$if` is for the one thing that cannot: branching on database state, which the builder cannot
read because it never connects. The condition travels in the document and the engine evaluates
it at that position, inside the transaction, so it sees everything ordered before it.

```ts
db.$if({ notExists: { model: "SiteSettings" } }, () => {
  db._global_site_settings.create({ site_name: "Launch Test" })
})

db.$if({ exists: { model: "Event", where: eq("status", "published") } }, () => {
  db.promo_code.create({ ... })
})

db.$if({ environment: "staging" }, () => { ... })
```

`where` is your schema's own rule language, scoped to one model: `eq`, `neq`, `gt`, `gte`, `lt`,
`lte`, `like`, `isNull`, `notNull`, `oneOf`, `and`, `or`, `not`. Omit it for "is this table
empty". The helpers are re-exported from the generated builder, so one import covers them.

A condition naming another model's column does not compile.

## What a run reports

```
seeds/01-organisers.ts   committed  (Organiser 2, Venue 3)
seeds/02-events.ts       committed  (Event 7, TicketType 9)
```

A group whose condition was false is reported as skipped rather than omitted, so a seed that
quietly did nothing does not look like one that did everything.

Failures arrive in your schema's terms, not Postgres's: `Organiser.slug is already taken`
rather than `duplicate key value violates unique constraint "organiser_slug_key"`, with the
file and the position in the document that caused it.

| Exit code | Meaning |
|-----------|---------|
| `0` | Applied |
| `1` | A seed failed: the data is wrong |
| `2` | The run could not start: config, connection, Cloud guard, or a missing builder |

The split lets CI tell "fix the seed" from "fix the environment".

## Files and transactions

`supatype seed` runs `seeds/*.ts` alphabetically, or `seed.ts` if that directory is absent. A
path argument runs one file.

One document is always one transaction. Across several files the run is **not** atomic unless
you ask: a failure in the third of five leaves the first two committed, and the report says so.

```
supatype seed --atomic        # every file in one transaction
```

## The ledger

Every run is recorded in `_supatype.seeds`, beside `_supatype.migrations`, inside the same
transaction as the writes it describes. A rolled-back seed either leaves no row at all or one
explicitly marked `rolled_back`; it can never claim a seed applied when it did not.

```
supatype seed --status
```

reports, per file: when it was applied, how long it took, what it wrote, and whether the file
has **drifted**, meaning its latest run used a different document than the run before it. Studio
shows the same thing under Database > Seeds.

**It is a record, not a gate.** Seeds are idempotent upserts by design, so a file is not skipped
because it ran before. The one exception:

```ts
export const config = { runOnce: true }
```

for a genuine one-time backfill rather than a fixture. The engine then skips a document already
committed with that exact content. Keyed on the content, not the filename: a file that changed
is a different backfill.

## Other flags

| Flag | Purpose |
|------|---------|
| `--connection <dsn>` | Seed a specific database instead of the resolved one |
| `--environment <name>` | Sets what an `{ environment: ... }` condition matches |
| `--force` | Allow running against a project linked to Supatype Cloud |

The connection string is resolved from, in order: `--connection`, `database.external.url`,
`connection` in `supatype.config.ts`, `DATABASE_URL` in the environment, `DATABASE_URL` in the
project's `.env`, then the project's own local database. When none of those has one, the error
names every source it tried and what was at each.

## The older form still works

A seed file with no default export runs on import, as it always did:

```ts
import { sql } from "@supatype/cli/seed"
const db = sql(process.env["DATABASE_URL"]!)
await db`INSERT INTO profile ...`
await db.end()
```

`supatype seed` detects the shape, runs it, and prints a notice naming the file. Nothing about
that form has been removed. What it does not get is the ordering, the batching, the single
transaction, the schema-term errors or the ledger, because those all live on the other side of
the document boundary.

## Why the document exists

The builder emits a language-neutral IR, and the engine does everything hard with it once:
validation, ordering, batching, execution, and mapping a Postgres error back to the schema you
wrote. A second language SDK is a builder and a runner, not a second implementation of any of
that. The IR is versioned separately from the schema AST and carries a fingerprint of the schema
it was built against, so a seed built against an older schema is refused with the remedy named
rather than failing partway through on a column that has since moved.
