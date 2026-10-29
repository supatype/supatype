---
title: "Seeding"
description: "Fill a Supatype database with fixture data: seed files, the generated builder, create and upsert, nested children, rich text, relations, database defaults, users and supatype seed."
head:
  - tag: title
    content: "Seeding a Postgres database from TypeScript | Supatype"
  - tag: meta
    attrs:
      property: "og:image"
      content: "https://www.supatype.com/og/seeding.png"
---

A seed file describes the rows you want. Supatype checks it against your schema, orders the writes by foreign key and applies them in one transaction.

Pre-1.0: APIs and config may change between releases.

<h2 id="files">Seed files</h2>

Put seed files in `seeds/`. They run in alphabetical order, so name them `01-authors.ts`, `02-posts.ts`. Without a `seeds/` folder, `seed.ts` at the project root runs instead.

Each file exports a default function. The function does not connect or await anything. It records the writes, and the engine applies them.

```ts title="seeds/01-blog.ts"
import type { SeedContext } from "@supatype/cli/seed"

// Sign-in users are not seeded. Create them first, then use their ids:
//   supatype admin create-user --email alex@example.com --role editor
//   supatype admin list-users
const ALEX = "00000000-0000-4000-8000-0000000000a1"

export default async function seed({ db, expr, log }: SeedContext) {
  log("seeding authors, tags and posts")

  db.author.upsert({
    where: { id: ALEX },
    data: { id: ALEX, name: "Alex Rivera" },
  })

  db.tag.upsert({ where: { name: "news" }, data: { name: "news" } })

  db.post.upsert({
    where: { slug: "hello-world" },
    data: {
      title: "Hello world",
      slug: "hello-world",
      body: "Our first post.",
      kind: "news",
      views: expr.default(),
      published_at: expr.ago({ days: 1 }),
      author: { connect: { id: ALEX } },
      comments: { create: [{ user_id: ALEX, body: "First!" }] },
    },
  })
}
```

This uses the schema from the [Schema](/docs/schema.html#relations) page.

<h2 id="builder">The builder</h2>

`db` has one property per table, typed from your schema. A wrong column or a missing required field fails to compile.

The types come from `supatype/generated/seed.ts`. `supatype generate`, `supatype dev` and `supatype push` write it. It needs no database, so it is gitignored and rebuilt on install.

The context also has `expr` (values the database computes), `log` (print a line) and `environment` (the `--environment` name, if given).

<h2 id="upsert">Create and upsert</h2>

| Call | Does |
| --- | --- |
| `db.tag.create(data)` | Inserts one row. Running the seed again inserts it again |
| `db.tag.createMany(rows)` | Inserts many rows in one statement |
| `db.tag.upsert({ where, data })` | Inserts the row, or updates the row `where` names |

Use `upsert` for fixtures. Seeds get run again, and `upsert` makes that safe. `where` takes only columns that name one row: the primary key or a `Unique<>` column. A model with neither cannot be upserted, so give it a unique key.

Fields you leave out of `data` keep their current value when an upsert updates.

<h2 id="relations">Relations</h2>

Set a foreign key by naming the related row by any unique key:

```ts title="seeds/02-posts.ts"
db.post.upsert({
  where: { slug: "second-post" },
  data: {
    title: "Second post",
    slug: "second-post",
    body: "More news.",
    kind: "news",
    author: { connect: { id: ALEX } },
  },
})
```

`create` and `upsert` return a reference you can use in later writes, such as `post.id`. It is not a value read from the database. The engine fills it in when it applies the seed.

```ts title="seeds/02-posts.ts"
const tag = db.tag.create({ name: "release" })
log(`created a tag, referenced as ${String(tag.id)}`)
```

<h2 id="children">Nested children</h2>

Write a row's children inside it with `create` or `createMany`. Their foreign keys are filled in for you.

Under an `upsert`, a child is written only if the parent has no child with the same values. So:

- Running the seed again adds nothing.
- A child whose values you changed is added beside the old one. The old one stays.
- A child that matches is not updated. To change one, upsert it on its own model by a unique key.
- Values the database computes, fields left out and `expr.default()` are not compared.

<h2 id="values">Rich text and defaults</h2>

A `RichText` field takes a plain string. It becomes a one-paragraph document. Rich text inside a block is not converted, so write the full document there.

`expr` gives values the database works out when the seed runs:

```ts title="seeds/02-posts.ts"
db.post.upsert({
  where: { slug: "launch-day" },
  data: {
    title: "Launch day",
    slug: "launch-day",
    body: "We are live.",
    kind: "news",
    views: expr.default(),
    published_at: expr.now({ days: 7 }),
    author: { connect: { id: ALEX } },
  },
})
```

`expr.now()`, `expr.ago({ days: 1 })` and `expr.startOf("day", { days: 30, hours: 9 })` are times. They only fit date fields.

`expr.default()` sets the column's own default. It is sent as `{ "$default": true }`. Leaving a field out of an upsert keeps the old value. `expr.default()` resets it. It only fits columns that have a default.

Leave `id` out and the database makes one.

<h2 id="users">Sign-in users</h2>

A seed cannot create sign-in users. Users live in the auth schema, which the seed builder does not reach. Create them first, then put their ids in the seed:

```sh
$ supatype admin create-user --email alex@example.com --role editor
$ supatype admin list-users
```

`create-user` also gives the user a Studio role (`admin` if you do not pass `--role`). `list-users` prints each id.

For app users with no Studio access, sign them up through the client's `auth.signUp`, or create them in Studio under Authentication > Users with Studio access set to "No access".

A `SupatypeAuthUserId` field with `onDelete` has a foreign key to the user, so the user must exist before the seed runs.

<h2 id="junction">Many-to-many rows</h2>

Many-to-many relations have no nested write. The rows live in the junction table, which the builder does not list. Write them with `db.$sql`, which runs in the same transaction:

```ts title="seeds/03-tags.ts"
db.$sql(
  `insert into post_tag (post_id, tag_id)
   select p.id, t.id from post p, tag t
   where p.slug = $1 and t.name = $2
   on conflict do nothing`,
  ["hello-world", "news"],
)
```

The statement runs at its position in the file, after every write above it, so it can read the rows those writes made.

Each param binds by its JSON type: a string as `text`, a whole number as `bigint`, any other number as `double precision`, a boolean as `boolean`, and an object or array as `jsonb`. A column of another type needs a cast on its placeholder, such as `$1::uuid`. That includes an id taken from an earlier write, such as `post.id`, which binds as text:

```ts title="seeds/03-tags.ts"
const post = db.post.create({ slug: "hello-world", title: "Hello" })
db.$sql(
  `insert into post_tag (post_id, tag_id)
   select $1::uuid, t.id from tag t where t.name = $2
   on conflict do nothing`,
  [post.id, "news"],
)
```

:::note[One param per placeholder]
Pass exactly one param for each of `$1` to `$n` in the statement. A count that does not match is refused before anything runs. A param is a value, so write expressions such as `now()` in the statement itself.
:::

<h2 id="run">Running seeds</h2>

```sh
$ supatype seed                    # every file in seeds/
$ supatype seed seeds/02-posts.ts  # one file
$ supatype seed --atomic           # all files in one transaction
$ supatype seed --status           # what ran, when, and what it wrote
```

Each file is one transaction. Without `--atomic`, a failure in the third file leaves the first two applied, and the report says so.

Errors name your schema, such as `Tag.name is already taken`, with the file and position. Exit code `1` means a seed failed. Exit code `2` means the run could not start.

A seed writes the model's own table, so rows on a drafts model are seeded as published.
