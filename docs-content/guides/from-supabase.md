---
title: "Coming from Supabase"
description: "How Supabase tables, RLS policies, supabase-js, storage, auth, realtime and functions map to Supatype, with a before and after example and how to adopt existing tables."
---

Supatype runs on Postgres with row level security, a REST and GraphQL API, auth, storage, realtime and functions, so most of what you know carries over. The difference is where it starts: you write TypeScript types and access rules, and Supatype writes the SQL, the policies and the client types from them.

<h2 id="map">What maps to what</h2>

| In Supabase | In Supatype |
| --- | --- |
| `create table` in SQL migration files | A `Model<>` type in `schema/index.ts`. See [Models](/docs/schema.html#models) |
| RLS policies written with `create policy` | An `access` rule for `read`, `create`, `update` and `delete` on the model. Supatype turns it into row level security. See [Access rules](/docs/schema.html#access) |
| Column privileges and views to hide a column | A field rule under `access.fields`. A caller who may not read the column gets `null`. See [Field rules](/docs/schema.html#field-rules) |
| Applying migrations, then running `supabase gen types` | `supatype dev` locally, `supatype push` elsewhere. Both apply the schema and write the client types |
| `supabase-js` | `@supatype/client`, imported from the generated `supatype/generated/client`. See [Create the client](/docs/client.html#setup) |
| Studio table editor | Supatype Studio: a form for each model built from its fields, version history and drafts, a media library, plus database views and a SQL runner. See [Studio roles](/docs/studio-roles.html) |
| Storage buckets and policies on `storage.objects` | A `Bucket<>` type with the same four rules as a model. See [Storage buckets](/docs/schema.html#buckets) |
| Supabase Auth | Supatype's auth service, reached through `supatype.auth`: sign up, password, magic links, OAuth, one-time codes and MFA. See [Auth](/docs/client.html#auth) |
| Realtime `postgres_changes` on a channel | `supatype.from("table").subscribe()`. Broadcast and presence use `supatype.realtime.channel(name)`. See [Realtime](/docs/client.html#realtime) |
| Edge Functions on Deno | Functions on Deno, called at `/functions/v1/<name>` and from `supatype.functions.invoke`. See [Functions](/docs/client.html#functions) |

<h2 id="stop-writing">What you stop writing</h2>

- SQL for tables, columns, indexes, foreign keys and enums. The model type declares them.
- One RLS policy per operation, with `using` and `with check` kept in step by hand. One rule per operation does both.
- Migration files. A push compares your schema with the database, shows the plan and asks before anything that can lose data. `supatype diff` shows the plan without applying it.
- A separate type generation step after each migration. Types are written on every `supatype dev` save and every `supatype push`.
- Bucket policies in SQL. A bucket's rules sit next to the models in the schema.

<h2 id="example">Before and after</h2>

A posts table where anyone reads published posts, and authors read and change their own.

### Supabase

```sql title="supabase/migrations/20260101000000_posts.sql"
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  status text not null default 'draft' check (status in ('draft', 'published'))
);

alter table public.posts enable row level security;

create policy "Read published or own" on public.posts for select
  using (status = 'published' or (select auth.uid()) = author_id);
create policy "Insert own" on public.posts for insert to authenticated
  with check ((select auth.uid()) = author_id);
create policy "Update own" on public.posts for update to authenticated
  using ((select auth.uid()) = author_id) with check ((select auth.uid()) = author_id);
create policy "Delete own" on public.posts for delete to authenticated
  using ((select auth.uid()) = author_id);
```

```sh
$ supabase migration up
$ supabase gen types typescript --local > database.types.ts
```

### Supatype

```ts title="schema/index.ts"
import type { Model, UUID, SupatypeAuthUserId, Default, Owner, Any, Eq, Literal } from "@supatype/types"

export type Post = Model<{
  id: UUID
  author_id: SupatypeAuthUserId<{ onDelete: "cascade" }>
  title: string
  status: Default<"draft" | "published", "draft">
}, {
  access: {
    read: Any<[Eq<"status", Literal<"published">>, Owner<"author_id">]>
    create: Owner<"author_id">
    update: Owner<"author_id">
    delete: Owner<"author_id">
  }
}>
```

```sh
$ supatype dev
```

The table is named `post`, from the type name. Set `tableName: "posts"` in the second argument to keep the old name. Because the `create` rule is `Owner<"author_id">`, the column defaults to the caller's id, so an insert can leave it out.

### The query

``` title="before: supabase-js"
import { createClient } from "@supabase/supabase-js"
import type { Database } from "./database.types"

const supabase = createClient<Database>(url, key)
const { data, error } = await supabase.from("posts").select("id, title").eq("status", "published")
```

``` title="after: @supatype/client"
import { createClient } from "../supatype/generated/client"

const supatype = createClient({ url, anonKey })
const { data, error } = await supatype.from("post").select("id, title").eq("status", "published")
```

The query builder reads the same way. The differences are in the setup: `createClient` takes one object with `url` and `anonKey`, and it comes from the generated file, so there is no type argument to pass.

<h2 id="client-differences">Small differences in the client</h2>

- Session fields are camel case: `session.accessToken`, `session.refreshToken`, `session.expiresAt`.
- Row changes are subscribed from the table: `supatype.from("comment").subscribe(cb, { event: "INSERT" })`. Each change reaches only subscribers allowed to read that row.
- `error` is a plain object with `message` and, when known, `code`. An insert an access rule refuses returns `42501`. See [Errors](/docs/client.html#errors).
- A function is a Deno module with a default export, `handler(req, ctx)`. The project URL and keys come from `ctx`, not the environment. `supatype functions new hello` writes one to start from.

<h2 id="existing-database">Bringing an existing database</h2>

`supatype pull` reads a live database and drafts `schema/index.ts` from it. It prints the draft unless you pass `--out`.

```sh
$ supatype pull --connection "postgres://..." --out schema/index.ts
$ supatype diff
```

Read the draft before you push it. It is a starting point, not a translation:

- Every model is drafted with `Public` for all four rules. Your RLS policies are not read. Replace each rule with the one you mean.
- An `id` column of type uuid is drafted as `SupatypeAuthUserId`. Change it to `UUID` on every table whose id is not a user's id.
- A uuid column ending in `_id` is drafted as a plain `UUID` with a comment suggesting a relation. Make it a `RelatedTo<>`, or a `SupatypeAuthUserId` when it points at a user.
- Model names come from table names, and the table name is derived back from the model name. Add `tableName` wherever the two differ, such as a plural table name.
- Tables whose names start with `_` are skipped.

<h3 id="adopt">Adopting tables Supatype did not create</h3>

A table that already exists was not created by Supatype, so a push refuses it: the access rules your schema declares for it would not be in force. In a terminal, `supatype push` says which tables, then asks `Adopt them now?`. Answer yes and it shows what adoption will take and asks `Adopt these?` before it changes anything. After adopting, it pushes again.

`--yes` does not answer the adoption questions. Agreeing to a push is not agreeing to take over tables, so with `--yes` or without a terminal the push stops and prints the command to run instead:

```sh
$ supatype adopt                      # shows what it would take, then asks
$ supatype adopt --key table:post     # adopt only the objects you name
$ supatype push
```

`supatype adopt --release <object>` tells every push to leave an object alone. `--reclaim <object>` hands it back. Objects are named the way `supatype doctor` names them: `kind:table.name`, or `kind:name` for a table.

<h2 id="not-carried">What does not carry over</h2>

- **Your SQL migrations.** Supatype does not replay `supabase/migrations`. It plans changes from the schema and records the migrations it applies.
- **Your RLS policies.** They are rewritten as access rules. Rules are types, and there is no raw SQL escape hatch, so a policy the rule types cannot express needs another approach, such as a hook or a function.
- **Generated types.** Delete `database.types.ts`. The client types come from the generated `supatype/generated` files.
- **Function entry points.** The handler shape differs, so each function's entry needs a small rewrite. The code inside, being Deno, mostly stays.
- **Function names and bodies in the client are not typed**, unlike tables.

:::note[Not covered here]
This page does not cover moving auth users or stored files between the two. Plan those as their own step.
:::
