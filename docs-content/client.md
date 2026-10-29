---
title: "Client"
description: "Use the typed @supatype/client: generated types, queries, filters, relations, drafts and publishing, auth, storage, realtime, functions and errors."
---

`@supatype/client` talks to your project's REST, auth, storage, realtime and functions. Its types come from your schema, so a wrong table or column fails the build.

Pre-1.0: APIs and config may change between releases.

<h2 id="setup">Create the client</h2>

Import `createClient` from the client file the CLI generates, not from `@supatype/client` directly. The generated file tells the client which models keep drafts.

```ts title="src/supatype.ts"
import { createClient } from "../supatype/generated/client"

export const supatype = createClient({
  url: import.meta.env.VITE_SUPATYPE_URL,
  anonKey: import.meta.env.VITE_SUPATYPE_ANON_KEY,
})
```

Every page in these docs imports the client from this one file. `supatype init` and `supatype keys` write `VITE_SUPATYPE_URL` and `VITE_SUPATYPE_ANON_KEY` to `.env`, with `PUBLIC_` and `EXPO_PUBLIC_` copies for other frameworks. Read them rather than copying a URL from an example: `init` picks a free gateway port for each project, kept in `.env` as `API_EXTERNAL_URL`.

The session is saved and restored by default. Pass `auth: { persistSession: false }` to keep it in memory only.

<h2 id="types">Generated types</h2>

`supatype dev`, `supatype push` and `supatype generate` write these files. Do not edit them.

| File | Holds |
| --- | --- |
| `supatype/generated/client.ts` | The `createClient` to import |
| `supatype/generated/index.d.ts` | Row, insert and update types for each table |
| `types/database.ts` | The `Database` type, for code that wants the raw shapes |

Tables are named as in the database: `post`, `comment`, `post_tag`. Calling `createClient` with no type argument picks up the generated types.

<h2 id="read">Read rows</h2>

```ts
const { data: posts, error } = await supatype
  .from("post")
  .select("id, title, slug, author(name), comment(body)")
  .order("published_at", { ascending: false })
  .limit(10)

if (error) throw new Error(error.message)
for (const post of posts ?? []) console.log(post.title, post.author?.name)
```

`select` takes a list of columns. The result type follows the list. `*` selects every column.

Name a related table to embed it: `author(name)` follows `author_id`, and `comment(body)` lists a post's comments. A many-to-many relation embeds through its junction table: `select("title, tag(name)")`.

A to-one embed can be `null`. Write `author!inner(name)` to keep only posts that have one. Rename an embed with `writer:author(name)`.

`single()` returns one row and errors when there is not exactly one. `maybeSingle()` returns `null` for no row.

```ts
const { data: post } = await supatype.from("post").select("*").eq("slug", "hello-world").maybeSingle()
console.log(post?.title)
```

<h2 id="filters">Filters</h2>

| Filter | Matches |
| --- | --- |
| `eq`, `neq` | equal, not equal |
| `gt`, `gte`, `lt`, `lte` | greater or less than |
| `like`, `ilike` | a pattern, `ilike` ignores case |
| `in` | any of a list |
| `is` | `null`, `true` or `false` |
| `not`, `or`, `match` | negation, either filter, several equalities |

```ts
await supatype.from("post").select("id").in("kind", ["news", "guide"]).is("published_at", null)
await supatype.from("post").select("id").ilike("title", "%hello%").range(0, 19)
```

Reads also take `order`, `limit` and `range`. Filters work on `update` and `delete` too.

<h2 id="write">Insert, update, delete</h2>

```ts
const { data: created, error: insertError } = await supatype
  .from("post")
  .insert({ title: "Draft idea", body: "Plain text is fine.", kind: "guide", author_id: userId })
  .select("id")
  .single()
if (insertError || !created) throw new Error(insertError?.message ?? "insert failed")

await supatype.from("comment").update({ body: "Edited" }).eq("id", commentId)
await supatype.from("comment").delete().eq("id", commentId)
```

A write returns no rows unless you add `.select()`. `upsert` inserts or updates by primary key.

A `RichText` field takes a plain string on write. Owner columns with an `Owner<>` create rule can be left out: they default to the caller.

<h2 id="drafts">Drafts and publishing</h2>

On a model with `versions: { drafts: true }`, `update` saves a draft. The live row does not change until the record is published.

```ts
// Save a draft
await supatype.from("post").update({ title: "Better title" }).eq("id", postId)

// Save and publish in one call
await supatype.from("post").update({ title: "Final title" }, { publish: true }).eq("id", postId)

// Read drafts
const { data: drafts } = await supatype.from("post").draft().select("id, title").eq("id", postId)

// Publish the saved draft
await supatype.rpc("publish", { model_table: "post", record_id: postId }, { schema: "supatype" })
```

`insert` on a drafts model creates a draft record. Publish it to make it live. A plain `select()` reads the live table, which holds the published values.

`{ publish: true }` is only accepted on drafts models, and only when the client comes from the generated file.

<h2 id="auth">Auth</h2>

```ts
await supatype.auth.signUp({ email: "alex@example.com", password: "a-long-password" })

const { data, error: signInError } = await supatype.auth.signInWithPassword({
  email: "alex@example.com",
  password: "a-long-password",
})
if (signInError) throw new Error(signInError.message)
console.log(data.session?.user.id)

const { data: { session } } = await supatype.auth.getSession()
console.log(session?.accessToken)

const { data: { subscription } } = supatype.auth.onAuthStateChange((event, current) => {
  console.log(event, current?.user.email)
})
subscription.unsubscribe()

await supatype.auth.signOut()
```

Once signed in, every request carries the user's token, so access rules see them. `onAuthStateChange` calls back at once with the current state, then on each change.

`getUser()` fetches the user from the server. Magic links, OAuth, one-time codes and MFA are on `supatype.auth` too.

<h2 id="storage">Storage</h2>

```ts
const bucket = supatype.storage.from("covers")

const { data: upload, error: uploadError } = await bucket.upload(`${userId}/cover.png`, file, {
  contentType: "image/png",
  upsert: true,
})
if (uploadError || !upload) throw new Error(uploadError?.message ?? "upload failed")

const { data: { publicUrl } } = bucket.getPublicUrl(upload.path)
const { data: signed } = await bucket.createSignedUrl(upload.path, 60)
console.log(publicUrl, signed?.signedUrl)
```

`getPublicUrl` works for public buckets. `createSignedUrl` gives a link that expires after the number of seconds you pass. `download`, `list` and `remove` are on the bucket too.

The bucket's access rules from the schema decide who may upload, overwrite and delete.

<h2 id="realtime">Realtime</h2>

```ts
const sub = supatype.from("comment").subscribe((change) => {
  console.log(change.eventType, change.new, change.old)
}, { event: "INSERT" })

sub.unsubscribe()
```

Each change reaches only subscribers allowed to read that row. `event` is `INSERT`, `UPDATE`, `DELETE` or `*`. For broadcast and presence, use `supatype.realtime.channel(name)`.

<h2 id="functions">Functions</h2>

```ts
const { data: reply, error: fnError } = await supatype.functions.invoke("hello", { body: { name: "Alex" } })
if (fnError) console.error(fnError.code, fnError.message)
console.log(reply)
```

The call goes to `/functions/v1/hello` with the user's token. A JSON response is parsed. Function names and bodies are not typed.

<h2 id="graphql">GraphQL</h2>

```ts
import type { TableRow } from "../supatype/generated/client"

type Post = TableRow<"post">
type PostPage = { postCollection: { edges: { node: Pick<Post, "title" | "body"> }[] } }

const { data, error } = await supatype.graphql<PostPage>(`{
  postCollection(first: 10) { edges { node { title body } } }
}`)
const firstParagraph = data?.postCollection.edges[0]?.node.body.root.children?.[0]
```

The query goes to `/graphql/v1` as the signed-in user, under the same access rules as REST. Pass variables as the second argument, and `{ idempotent: true }` as the third to retry a read on a transient failure.

Rich text, blocks and json fields come back as objects and arrays, not strings. pg_graphql types every json and jsonb column with its `JSON` scalar and sends it as a JSON-encoded string, so the client reads the schema once per role, finds each field of that type in your query, and decodes it. Aliases, named and inline fragments, nested relations and lists all decode. A field the client cannot place stays exactly as returned: one added since the schema was read (it reads the schema again on the next call), a document with more than one operation, or a schema it could not read.

The type argument names the answer's shape and is not checked at runtime. Build it from the generated `TableRow` types so `body` is typed as the rich text document it now is. Variables you send are not encoded: a json argument still takes a string.

Using another GraphQL client? `readGraphqlSchema` reads the `data` of an introspection answer to `GRAPHQL_SCHEMA_QUERY`, and `decodeGraphqlJsonFields(query, data, schema)` decodes an answer the same way.

<h2 id="errors">Errors</h2>

Queries, `rpc`, `functions.invoke`, auth and most storage calls return `{ data, error }`. Check `error` before using `data`.

`error` is a plain object with `message` and, when known, `code`, `status`, `details` and `hint`. Do not test it with `instanceof`.

An insert an access rule refuses returns code `42501`. An update or delete that the rules hide matches no rows and returns no error. `single()` with no row returns `PGRST116`.

:::note[Network failures]
A network failure on a query, `rpc` or function call comes back as `error` with a code such as `NETWORK_TIMEOUT`. Auth and storage calls throw instead, so wrap them in `try` when the network may fail.
:::
