---
title: "Coming from Prisma"
description: "How schema.prisma, prisma migrate and Prisma Client map to Supatype types, push and the typed client, what Supatype adds, and what does not carry over."
---

Prisma gives you tables, migrations and a typed client from one schema file. Supatype does the same from TypeScript types, then goes on to access rules, an API, an admin UI, auth and storage, which with Prisma you write yourself.

<h2 id="map">What maps to what</h2>

| In Prisma | In Supatype |
| --- | --- |
| `model` in `schema.prisma` | A `Model<>` type in `schema/index.ts`. See [Models](/docs/schema.html#models) |
| `prisma migrate dev` | `supatype dev`: each save is applied to the local database |
| `prisma migrate deploy` | `supatype push`, which shows the plan and asks before anything that can lose data |
| `prisma migrate diff` | `supatype diff`: the plan, without applying it |
| `prisma db pull` | `supatype pull`: a draft schema from a live database |
| `prisma generate` | Types are written by `supatype dev` and `supatype push`. `supatype generate` writes them on their own |
| Prisma Client | `@supatype/client`. See [Client](/docs/client.html) |
| Prisma Studio | Supatype Studio, a CMS built from the schema. See [Studio roles](/docs/studio-roles.html) |
| `prisma db seed` | `supatype seed`. See [Seeding](/docs/seeding.html) |

<h3 id="fields">Field by field</h3>

| Prisma | Supatype |
| --- | --- |
| `String @id @default(uuid())` | `id: UUID`. The database fills it in |
| `String?` | `Optional<string>`. Every other field is `NOT NULL` |
| `@unique` | `Unique<T>` |
| `@default(value)` | `Default<T, value>` |
| `enum Status { draft published }` | `"draft" \| "published"` |
| `Json` | `JSON<T>`, typed as `T` in the client |
| `@relation(fields: [authorId], references: [id])` | `RelatedTo<Author>`, which adds the column `author_id` |
| The list side, `posts Post[]` | `HasMany<Post>`. It adds no column |
| An implicit many-to-many | `ManyToMany<Tag>`, one junction table for the pair |
| `@@index`, `@@map` | `indexes` and `tableName` in the model's second argument |

The full list is in [Field types](/docs/schema.html#fields) and [Relations](/docs/schema.html#relations).

<h2 id="example">Before and after</h2>

### Prisma

```prisma title="prisma/schema.prisma"
enum Status {
  draft
  published
}

model Author {
  id    String @id @default(uuid())
  email String @unique
  name  String
  posts Post[]
}

model Post {
  id       String @id @default(uuid())
  title    String
  status   Status @default(draft)
  author   Author @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId String
}
```

```ts title="before: Prisma Client"
const posts = await prisma.post.findMany({
  where: { status: "published" },
  select: { id: true, title: true, author: { select: { name: true } } },
})
```

### Supatype

```ts title="schema/index.ts"
import type {
  Model, UUID, Email, Unique, Default, SupatypeAuthUserId,
  RelatedTo, HasMany, Public, Owner, Any, Eq, Literal,
} from "@supatype/types"

export type Author = Model<{
  id: SupatypeAuthUserId
  email: Unique<Email>
  name: string
  posts: HasMany<Post>
}, {
  access: { read: Public; create: Owner<"id">; update: Owner<"id">; delete: Owner<"id"> }
}>

export type Post = Model<{
  id: UUID
  title: string
  status: Default<"draft" | "published", "draft">
  author: RelatedTo<Author, { required: true; onDelete: "cascade" }>
}, {
  access: {
    read: Any<[Eq<"status", Literal<"published">>, Owner<"author_id">]>
    create: Owner<"author_id">
    update: Owner<"author_id">
    delete: Owner<"author_id">
  }
}>
```

```ts title="after: @supatype/client"
const { data: posts, error } = await supatype
  .from("post")
  .select("id, title, author(name)")
  .eq("status", "published")
```

The author's id is a sign-in user's id, so each author row belongs to a user. The `access` blocks are the part Prisma has no place for: they become Postgres row level security, so the same query returns only what the caller may see, whether it runs on your server or in the browser.

<h2 id="adds">What Supatype adds</h2>

- **Access rules in the database.** Each model's rules become row level security, and field rules mask single columns. They hold for REST, GraphQL, realtime and the client alike. See [Access rules](/docs/schema.html#access).
- **An API you do not write.** Every model with access rules is reachable over REST and GraphQL. A model with no `access` at all is not.
- **A client that runs in the browser.** It holds the anon key and the user's session, not a database connection.
- **Studio.** A form for each model built from its fields, drafts and version history, a media library, and roles for the people who edit content. See [Studio roles](/docs/studio-roles.html).
- **Auth, storage, realtime and functions** in the same project. Buckets are declared in the schema next to the models. See [Auth](/docs/client.html#auth), [Storage](/docs/client.html#storage), [Realtime](/docs/client.html#realtime) and [Functions](/docs/client.html#functions).

<h2 id="existing-database">Bringing an existing database</h2>

`supatype pull` drafts a schema from a live database. Prisma's `_prisma_migrations` table is skipped, along with any table whose name starts with `_`.

```sh
$ supatype pull --connection "postgres://..." --out schema/index.ts
$ supatype diff
```

Prisma's defaults and Supatype's differ, so expect to edit the draft:

- Prisma names a table after the model, such as `"Post"`. Supatype derives the table name from the model name in snake case, so `Post` means `post`. Add `tableName: "Post"` to keep the existing table.
- A field's name is its column's name. A relation's column is the field name plus `_id`, and there is no option to name it otherwise, so a Prisma `authorId` column does not line up with an `author` relation. Keep it as a plain field, or rename the column.
- Every drafted model has `Public` for all four rules. Replace them with the rules you mean before you push.
- An `id` column of type uuid is drafted as `SupatypeAuthUserId`. Change it to `UUID` on every table whose id is not a user's id.
- Prisma fills `@default(uuid())` in the client, and stores a `String` id as text unless you used `@db.Uuid`. Such an id is drafted as a string, not a `UUID`.

The first push refuses tables that exist and that Supatype did not create. In a terminal it offers to adopt them: it asks `Adopt them now?`, shows what adoption will take, and asks again before changing anything. `--yes` does not answer those questions. Without a terminal, run `supatype adopt` and then push again. See [What a push refuses](/docs/schema.html#push).

<h2 id="not-carried">What does not carry over</h2>

- **Other databases.** Supatype runs on Postgres 17 only. MySQL, SQLite, SQL Server and MongoDB projects need moving to Postgres first.
- **Your migrations folder.** Supatype does not read `prisma/migrations`. It compares the schema with the database and plans the change itself.
- **Nested writes and transactions.** The client writes one table per call and has no transaction API. Put a write that must touch several tables at once in a function.
- **Raw queries.** There is no `$queryRaw`. Studio has a SQL runner for one-off queries.
- **Client extensions and middleware.** Logic that ran around every query belongs in access rules, model hooks or functions.

:::note[Prisma 8]
Prisma 8, in release candidates at the time of writing, replaces `schema.prisma` with `contract.prisma` and renames the migrate commands. The mapping above is to Prisma 7.
:::
