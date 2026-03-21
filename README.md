<p align="center">
  <img src="https://raw.githubusercontent.com/supatype/supatype/main/docs/logo.svg" alt="Supatype" width="200" />
</p>

<h1 align="center">Supatype</h1>

<p align="center">
  <strong>Define your types. We generate your backend.</strong><br/>
  One TypeScript schema. Postgres database, REST + GraphQL API, typed SDK, auth, storage, realtime, and a full CMS admin panel — all generated automatically.
</p>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#packages">Packages</a> ·
  <a href="#documentation">Documentation</a>
</p>

---

## What is Supatype?

> Define your types. We generate your backend.

### The Problem

Building a backend in 2026 still means stitching together the same pieces by hand. You write SQL to create tables. You configure an API layer to expose them. You set up auth and write security policies. You build an admin panel so non-technical people can manage content. You generate TypeScript types so your frontend has type safety. You write migrations when things change. You deploy and manage infrastructure.

Every one of these steps exists because the tools you use don't talk to each other. Your database doesn't know about your types. Your API doesn't know about your access rules. Your admin panel doesn't know about your schema. Your frontend types don't know about your database columns. You're the glue — manually keeping everything in sync.

### The Idea

What if you wrote your data model once, in TypeScript, and everything else was generated?

```typescript
import { model, field, access, timestamps, publishable } from '@supatype/schema'

export const product = model('product', {
  fields: {
    name:        field.text({ required: true, localized: true }),
    description: field.richText({ localized: true }),
    price:       field.decimal({ precision: 10, scale: 2 }),
    image:       field.image({ bucket: 'products' }),
    category:    relation.belongsTo('category'),
    seller:      relation.belongsTo('user'),
  },
  composites: [timestamps(), publishable()],
  access: {
    read:   access.public(),
    create: access.role('seller'),
    update: access.owner('seller_id'),
    delete: access.owner('seller_id'),
  },
})
```

From this one definition, you get:

- **Postgres database** — tables, columns, indexes, constraints, foreign keys. Migrations generated automatically when the schema changes.
- **REST + GraphQL API** — CRUD endpoints with filtering, pagination, ordering, and relation embedding. No code.
- **Row-level security** — Postgres RLS policies generated from the `access` rules. `access.owner('seller_id')` becomes a real database policy enforcing data isolation at the row level.
- **TypeScript SDK** — type-safe client with autocomplete for every table, column, and relation.
- **Admin panel** — auto-generated content management interface. Non-technical users can create, edit, and publish records without touching code. Rich text editor, media library, localization, publishing workflows — all from the schema definition.
- **Auth** — email/password, OAuth (GitHub, Google, Apple), MFA, magic links, phone OTP.
- **Storage** — file uploads, image transformations (resize, crop, format conversion), pre-signed URLs. `field.image()` auto-creates a storage bucket.
- **Realtime** — WebSocket subscriptions for live data updates, filtered by the same RLS policies.
- **Edge functions** — serverless TypeScript functions for custom business logic.
- **Localisation** — `localized: true` on any text field stores content per-locale. The admin panel shows per-locale editing automatically.

One schema. One push. Everything generated.

```bash
npx supatype push
```

### How It Works

The core of Supatype is a Rust binary called the schema engine. When you run `supatype push`, it:

1. Loads your TypeScript schema files and serialises them to a JSON AST
2. Introspects your current Postgres database
3. Diffs the AST against the database state
4. Generates a SQL migration (with risk analysis: safe, cautious, or destructive)
5. Prompts you to confirm destructive changes, then applies the migration
6. Regenerates TypeScript types, updates the REST/GraphQL API config, rebuilds RLS policies, and refreshes the admin panel schema cache

The engine runs the full pipeline in under 500ms for a typical schema. It handles rename detection, topological dependency ordering, and rollback generation for every migration.

### Self-Host or Cloud

Supatype runs in three modes — and your schema, CLI, SDK, and admin panel are identical in all three:

- **Local dev** — `supatype dev` starts the full stack in Docker Compose. Postgres, the API, auth, storage, and admin panel all running locally. Hot reload on schema changes.
- **Self-hosted** — `supatype self-host setup` generates a production deployment for any VPS. Docker Compose with automatic HTTPS. Your data stays on your hardware.
- **Supatype Cloud** — managed infrastructure. Push your schema, get a live project in seconds.

### Who Is It For?

**Developers who think in TypeScript, not SQL.** You know your data shapes. You shouldn't have to mentally translate them into `CREATE TABLE` statements and keep your types, API, and database in sync by hand.

**Teams that need a CMS without adopting a separate CMS.** Your client needs to edit content. You don't want to run Payload or Strapi as a second system alongside your backend. Supatype's admin panel is auto-generated from the same schema that defines your database — one system, not two.

**Solo founders shipping fast.** Auth, database, file uploads, admin panel, REST API — from one schema definition. Deployed this weekend.

**Agencies delivering client projects.** Define the data model, push, hand the admin panel to the client. Same tools and patterns on every project, different schema.

### How Supatype Compares

**vs Supabase** — Supabase starts at the database (SQL first, types generated from it). No admin panel. Supatype starts at the TypeScript schema and generates the database, API, types, RLS policies, and admin panel from it. Both use Postgres under the hood.

**vs Payload CMS** — Payload is the best headless CMS available but it's CMS-first, not backend-first. It doesn't provision databases, manage auth as a service, provide realtime, run edge functions, or handle deployment. Supatype generates an admin panel comparable to Payload's — plus the entire backend.

**vs Convex** — Convex is a reactive TypeScript backend with real-time sync, but it's a proprietary database (not Postgres). No SQL access, no PostGIS, no pgvector, no self-hosting, no admin panel.

**vs Firebase** — Firebase is a document database locked into Google Cloud with unpredictable costs at scale. Supatype is relational (Postgres), open-source core, self-hostable, and includes an admin panel.

### What's Open Source

The CLI, client SDK, React hooks, schema package, plugin SDK, admin panel, auth service, and all self-hosting tooling are MIT-licensed. The Rust schema engine binary is free to use but source-closed. The cloud control plane is proprietary.

### Pricing

|  | Free | Pro (£25/mo) | Team (£399/mo) | Enterprise |
|--|------|-------------|--------------|------------|
| Projects | 2 | 10 | Unlimited | Custom |
| Database | 500MB | 8GB dedicated | 50GB dedicated | Custom |
| Storage | 1GB | 100GB | 500GB | Custom |
| Auth MAU | 50,000 | 100,000 | Unlimited | Unlimited |
| Edge functions | 500K invocations | 2M | 10M | Unlimited |
| Self-host | Free forever | — | — | — |

---

---

## Installation

```bash
# Install the CLI globally
npm install -g @supatype/cli

# Or with pnpm
pnpm add -g @supatype/cli
```

Then scaffold a new project:

```bash
supatype init my-app
cd my-app
pnpm install
```

---

## Quick Start

### 1. Define your schema

```typescript
// schema/index.ts
import { model, field, relation, access } from "@supatype/schema"

export const User = model("user", {
  fields: {
    name: field.text({ required: true }),
    avatar: field.image({ bucket: "avatars" }),
  },
  access: {
    read: access.authenticated(),
    create: access.authenticated(),
    update: access.owner("user_id"),
    delete: access.owner("user_id"),
  },
  options: { timestamps: true },
})

export const Post = model("post", {
  fields: {
    title:     field.text({ required: true }),
    slug:      field.slug({ from: "title", unique: true }),
    body:      field.richText({ required: true }),
    cover:     field.image({ bucket: "post-images" }),
    authorId:  field.uuid({ required: true }),
    author:    relation.belongsTo("user"),
    comments:  relation.hasMany("comment"),
    status:    field.enumField(["draft", "published", "archived"]),
  },
  access: {
    read:   access.public(),
    create: access.authenticated(),
    update: access.owner("author_id"),
    delete: access.owner("author_id"),
  },
  indexes: [{ fields: ["slug"], unique: true }],
  options: { timestamps: true, softDelete: true },
})
```

### 2. Push to your database

```bash
supatype push
```

This applies migrations, creates RLS policies, and generates TypeScript types.

### 3. Query with a fully-typed client

```typescript
import { createClient } from "@supatype/client"
import type { Database } from "./types/database"

const client = createClient<Database>({
  url: process.env.SUPATYPE_URL,
  anonKey: process.env.SUPATYPE_ANON_KEY,
})

// Fully typed — no casting needed
const { data: posts, error } = await client
  .from("posts")
  .select("*, author(*)")
  .eq("status", "published")
  .order("created_at", { ascending: false })
  .limit(10)
```

### 4. Use React hooks

```tsx
import { SupatypeProvider, useQuery, useAuth } from "@supatype/react"

function PostList() {
  const { data: posts, loading } = useQuery("posts", {
    filter: { status: "published" },
    order: { column: "created_at", ascending: false },
    limit: 10,
  })

  if (loading) return <Spinner />
  return posts?.map(post => <PostCard key={post.id} post={post} />)
}

export default function App() {
  return (
    <SupatypeProvider client={client}>
      <PostList />
    </SupatypeProvider>
  )
}
```

---

## Packages

This is a monorepo containing the following packages:

| Package | Description |
|---|---|
| [`@supatype/schema`](#supatatypeschema) | Schema builder — define models, fields, relations, and access rules |
| [`@supatype/client`](#supatatypeclient) | Typed REST client — query, mutate, subscribe, auth, storage |
| [`@supatype/react`](#supatatypereact) | React hooks — `useQuery`, `useMutation`, `useAuth`, and more |
| [`@supatype/cli`](#supatatypecli) | CLI — push schemas, run migrations, generate types |

---

## `@supatype/schema`

The schema package is the heart of Supatype. Everything starts here.

```bash
pnpm add @supatype/schema
```

### Models

A model maps to a Postgres table. You define its fields, relations, access rules, indexes, and lifecycle hooks.

```typescript
import { model, field, relation, access, block } from "@supatype/schema"

const Article = model("article", {
  fields: {
    title:       field.text({ required: true }),
    slug:        field.slug({ from: "title", unique: true }),
    excerpt:     field.text(),
    body:        field.richText({ required: true }),
    publishedAt: field.timestamp(),
    authorId:    field.uuid({ required: true }),
    author:      relation.belongsTo("user"),
    tags:        field.arrayOf(field.text()),
    metadata:    field.json<{ seoTitle?: string; canonical?: string }>(),
  },
  access: {
    read:   access.public(),
    create: access.role("editor", "admin"),
    update: access.owner("author_id"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["slug"],       unique: true },
    { fields: ["author_id"],  using: "btree" },
    { fields: ["published_at"] },
  ],
  options: {
    timestamps: true,  // Adds created_at, updated_at
    softDelete: true,  // Adds deleted_at instead of hard delete
  },
  hooks: {
    beforeChange: "./hooks/validate-article.ts",
    afterChange:  "./hooks/notify-subscribers.ts",
  },
})
```

### Fields

Supatype ships with over 40 field types covering every Postgres primitive and common patterns:

#### Text & String

```typescript
field.text({ required?: boolean, maxLength?: number })
field.richText({ required?: boolean, localized?: boolean })
field.email()
field.url()
field.slug({ from: string, unique?: boolean })
```

#### Numbers

```typescript
field.integer({ required?: boolean, min?: number, max?: number })
field.bigSerial()
field.serial()
field.float()
field.decimal({ precision?: number, scale?: number })
field.money()
```

#### Boolean, Date & Time

```typescript
field.boolean()
field.date()
field.timestamp()
field.datetime()
```

#### IDs & References

```typescript
field.uuid({ required?: boolean })
field.enumField(["draft", "published", "archived"], { nativeType?: boolean })
```

#### Media & Files

```typescript
field.image({ bucket?: string, maxSize?: number | string, accept?: string[] })
field.file({ bucket?: string })
```

#### Data Structures

```typescript
field.json<TShape>()
field.arrayOf(field.text())
field.vector({ dimensions: number })   // pgvector
field.tsvector()                        // Full-text search
field.tsquery()
```

#### Geospatial

```typescript
field.geo({ type?: "point" | "polygon" | "linestring", srid?: number })
```

#### Rich Content (Block Builder)

```typescript
const HeroBlock = block("hero", {
  name:   "Hero Section",
  icon:   "layout",
  fields: {
    heading:  field.text({ required: true }),
    subtext:  field.text(),
    image:    field.image(),
    ctaLabel: field.text(),
    ctaUrl:   field.url(),
  },
})

const ContentBlock = block("content", {
  name:   "Content",
  fields: {
    body: field.richText({ required: true }),
  },
})

// Compose blocks into a page builder field
field.blocks([HeroBlock, ContentBlock], { maxNestingDepth: 3 })
```

### Relations

```typescript
import { relation } from "@supatype/schema"

// Belongs-to (foreign key on this table)
relation.belongsTo("user", {
  foreignKey?: "author_id",
  references?: "id",
  onDelete?:   "CASCADE" | "SET NULL" | "RESTRICT",
  onUpdate?:   "CASCADE",
})

// Has-many (foreign key on the other table)
relation.hasMany("comment", { foreignKey?: "post_id" })

// Has-one
relation.hasOne("profile", { foreignKey?: "user_id" })

// Many-to-many (join table)
relation.manyToMany("tag", { through?: "post_tags" })
```

### Access Control

Access rules compile to Postgres Row-Level Security policies. You never write SQL policies by hand.

```typescript
import { access } from "@supatype/schema"

// Allow everyone (no auth required)
access.public()

// Block all access (useful as a default)
access.private()

// Require a valid session
access.authenticated()

// Require session + ownership
access.owner("user_id")       // WHERE user_id = auth.uid()

// Require a specific role
access.role("admin", "editor")

// Raw SQL predicate (escape hatch)
access.custom("auth.uid() = user_id AND is_active = true")

// Logical OR — any rule grants access
access.any(
  access.owner("user_id"),
  access.role("admin"),
)

// Require MFA
access.mfaRequired()
```

Access rules are per-operation:

```typescript
access: {
  read:   access.public(),
  create: access.authenticated(),
  update: access.owner("user_id"),
  delete: access.role("admin"),
}
```

### Composites

Composites expand to multiple fields, saving repetition across models:

```typescript
import { composites } from "@supatype/schema"

// Adds: created_at, updated_at
composites.timestamps()

// Adds: status ('draft' | 'published' | 'archived'), published_at, scheduled_at
composites.publishable()

// Adds: deleted_at (enables soft delete)
composites.softDelete()
```

### Globals

Globals are singleton tables — one row, always. Useful for site-wide configuration:

```typescript
import { global } from "@supatype/schema"

export const SiteSettings = global("settings", {
  fields: {
    siteName:    field.text({ required: true }),
    logoUrl:     field.image({ bucket: "logos" }),
    theme:       field.enumField(["light", "dark"]),
    maintenance: field.boolean(),
  },
})
```

---

## `@supatype/client`

A lightweight, typed REST client. Works in any JavaScript runtime.

```bash
pnpm add @supatype/client
```

### Setup

```typescript
import { createClient } from "@supatype/client"
import type { Database } from "./types/database"

export const client = createClient<Database>({
  url: "https://api.example.com",
  anonKey: "eyJ...",
  auth: {
    persistSession: true,
    storageKey: "myapp.auth.session",
  },
  retry: true,
  timeout: 30_000,
})
```

### Querying

```typescript
// Select all published posts with author data
const { data, error, count } = await client
  .from("posts")
  .select("id, title, slug, created_at, author(name, avatar_url)")
  .eq("status", "published")
  .order("created_at", { ascending: false })
  .limit(20)

// Filters
.eq("status", "published")         // =
.neq("author_id", userId)          // !=
.gt("views", 1000)                 // >
.gte("views", 1000)                // >=
.lt("price", 50)                   // <
.lte("price", 50)                  // <=
.like("title", "%TypeScript%")     // LIKE
.ilike("title", "%typescript%")    // ILIKE (case-insensitive)
.in("status", ["draft", "published"])
.is("deleted_at", null)
.contains("tags", { category: "tech" })
.containedBy("roles", ["admin", "editor"])

// Pagination
.limit(10)
.range(0, 9)          // rows 0–9 (inclusive)

// Single row
.single()             // throws if 0 or >1 rows
.maybeSingle()        // returns null if 0 rows

// Localised fields
.locale("fr-FR")
```

### Mutating

```typescript
// Insert
await client.from("posts").insert({
  title: "Hello World",
  body: "...",
  author_id: user.id,
})

// Upsert (insert or update on conflict)
await client.from("posts").upsert({ id: "abc", title: "Updated" })

// Update
await client.from("posts")
  .update({ status: "published", published_at: new Date().toISOString() })
  .eq("id", postId)

// Delete
await client.from("posts").delete().eq("id", postId)
```

### Authentication

```typescript
// Sign up
const { data, error } = await client.auth.signUp({
  email: "user@example.com",
  password: "hunter2",
  options: { data: { name: "Jane Doe" } },
})

// Sign in with password
await client.auth.signInWithPassword({ email, password })

// Sign in with OAuth
const { data } = await client.auth.signInWithOAuth({
  provider: "google",
  options: { redirectTo: "https://myapp.com/auth/callback" },
})
// Redirect user to data.url

// Magic link / OTP
await client.auth.signInWithOtp({
  email: "user@example.com",
  options: { emailRedirectTo: "https://myapp.com/auth/confirm" },
})

// Session management
const { data: { session } } = await client.auth.getSession()
const { data: { user } }    = await client.auth.getUser()
await client.auth.signOut()

// Listen for auth changes
client.auth.onAuthStateChange((event, session) => {
  // event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'USER_UPDATED'
})

// Multi-factor authentication
const { data } = await client.auth.mfa.enroll({ factorType: "totp" })
await client.auth.mfa.challenge({ factorId: data.id })
await client.auth.mfa.verify({ factorId: data.id, code: "123456" })
```

### Storage

```typescript
const bucket = client.storage.from("images")

// Upload
const { data, error } = await bucket.upload("avatars/user-123.jpg", file, {
  contentType: "image/jpeg",
  upsert: true,
})

// Public URL with on-the-fly transforms
const { data: { publicUrl } } = bucket.getPublicUrl("avatars/user-123.jpg", {
  transform: { width: 128, height: 128, format: "webp", quality: 85 },
})

// Signed URL (time-limited)
const { data: { signedUrl } } = await bucket.createSignedUrl(
  "private/report.pdf",
  3600, // seconds
)

// Download
const { data: blob } = await bucket.download("exports/data.csv")

// Delete
await bucket.delete(["old-image.jpg", "another.jpg"])

// List
const { data: files } = await bucket.list({ limit: 100, sortBy: "name" })
```

### Realtime

```typescript
const channel = client.realtime
  .channel("public:posts")
  .on("postgres_changes", {
    event: "INSERT",
    schema: "public",
    table: "posts",
  }, (payload) => {
    console.log("New post:", payload.new)
  })
  .on("postgres_changes", {
    event: "UPDATE",
    filter: "id=eq.42",
  }, (payload) => {
    console.log("Updated post:", payload.new)
  })
  .on("postgres_changes", { event: "DELETE" }, (payload) => {
    console.log("Deleted:", payload.old)
  })
  .subscribe((status) => {
    console.log("Channel status:", status) // 'SUBSCRIBED'
  })

// Presence — track online users
channel.track({ userId: user.id, status: "online" })
channel.onPresence((event) => {
  console.log("Joined:", event.joins)
  console.log("Left:", event.leaves)
})

// Broadcast — ephemeral messages between clients
channel.broadcast("cursor", { x: 120, y: 340 })

// Cleanup
channel.unsubscribe()
```

### Edge Functions & RPC

```typescript
// Call an Edge Function
const { data, error } = await client.functions.invoke<{ orderId: string }>(
  "process-order",
  {
    method: "POST",
    body: { items: cart, address: shippingAddress },
  },
)

// Call a Postgres function via RPC
const { data } = await client.rpc<number>("calculate_shipping", {
  weight: 2.5,
  country: "DE",
})

// Query globals (singleton tables)
const { data: settings } = await client.global<SiteSettings>("settings").get()
await client.global("settings").update({ maintenance: true })
```

---

## `@supatype/react`

React bindings for Supatype. Built on top of `@supatype/client`.

```bash
pnpm add @supatype/react
```

### Setup

Wrap your app with `SupatypeProvider`:

```tsx
import { SupatypeProvider } from "@supatype/react"
import { createClient } from "@supatype/client"
import type { Database } from "./types/database"

const client = createClient<Database>({
  url: process.env.NEXT_PUBLIC_SUPATYPE_URL!,
  anonKey: process.env.NEXT_PUBLIC_SUPATYPE_ANON_KEY!,
})

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <SupatypeProvider client={client}>
      {children}
    </SupatypeProvider>
  )
}
```

### `useAuth`

```tsx
function Header() {
  const { user, loading, signIn, signOut, signInWithOAuth } = useAuth()

  if (loading) return null

  if (!user) {
    return (
      <button onClick={() => signInWithOAuth({ provider: "github" })}>
        Sign in with GitHub
      </button>
    )
  }

  return (
    <div>
      <span>Welcome, {user.userMetadata.name}</span>
      <button onClick={() => signOut()}>Sign out</button>
    </div>
  )
}
```

### `useQuery`

```tsx
function PostList() {
  const { data: posts, loading, error, refetch } = useQuery("posts", {
    select: "id, title, slug, excerpt, author(name)",
    filter: { status: "published" },
    order: { column: "published_at", ascending: false },
    limit: 12,
    refetchInterval: 30_000, // refresh every 30s
  })

  if (loading) return <Skeleton />
  if (error)   return <ErrorMessage error={error} />

  return (
    <ul>
      {posts?.map(post => (
        <li key={post.id}>
          <a href={`/posts/${post.slug}`}>{post.title}</a>
        </li>
      ))}
    </ul>
  )
}
```

### `useMutation`

```tsx
function CreatePostForm() {
  const { user } = useAuth()
  const { mutate: createPost, loading } = useMutation("posts", "insert")
  const { mutate: updatePost }          = useMutation("posts", "update")
  const { mutate: deletePost }          = useMutation("posts", "delete")

  const handleCreate = async (formData: FormData) => {
    const { data, error } = await createPost({
      title:     formData.get("title") as string,
      body:      formData.get("body") as string,
      author_id: user!.id,
      status:    "draft",
    })

    if (!error) router.push(`/posts/${data![0].slug}`)
  }

  const handlePublish = async (postId: string) => {
    await updatePost(
      { status: "published", published_at: new Date().toISOString() },
      { filter: { id: postId } },
    )
  }

  // ...
}
```

### `useSubscription`

```tsx
function LiveComments({ postId }: { postId: string }) {
  const [comments, setComments] = useState<Comment[]>([])

  const { status } = useSubscription("comments", {
    event: "*",
    filter: { post_id: `eq.${postId}` },
  })

  // Or handle events manually via the client
  useEffect(() => {
    const channel = client.realtime
      .channel("comments:" + postId)
      .on("postgres_changes", { event: "INSERT", table: "comments",
          filter: `post_id=eq.${postId}` },
        (payload) => setComments(prev => [...prev, payload.new as Comment])
      )
      .subscribe()

    return () => { channel.unsubscribe() }
  }, [postId])

  return (
    <div>
      <span>{status}</span>
      {comments.map(c => <Comment key={c.id} comment={c} />)}
    </div>
  )
}
```

### `useFunction`

```tsx
function CheckoutButton({ cart }: { cart: CartItem[] }) {
  const { invoke, loading, error } = useFunction<{ checkoutUrl: string }>(
    "create-checkout",
  )

  const handleCheckout = async () => {
    const { data } = await invoke({
      method: "POST",
      body: { items: cart },
    })
    if (data) window.location.href = data.checkoutUrl
  }

  return (
    <button onClick={handleCheckout} disabled={loading}>
      {loading ? "Processing..." : "Checkout"}
    </button>
  )
}
```

### `useLivePreview`

For CMS-style live editing — keep UI in sync with schema changes in real time:

```tsx
function PreviewPage({ id }: { id: string }) {
  const { data: page, loading } = useLivePreview("page", id)

  if (loading) return null
  return <PageRenderer blocks={page.content} />
}
```

---

## `@supatype/cli`

The CLI drives schema migrations, code generation, and deployment.

```bash
pnpm add -D @supatype/cli
```

### Commands

```bash
# Project setup
supatype init                    # Scaffold a new project
supatype init --template blog    # Use a starter template

# Development
supatype dev                     # Watch schemas, hot-reload types
supatype push                    # Apply schema → database
supatype pull                    # Reverse-engineer schema from database
supatype diff                    # Preview pending migration SQL

# Migrations
supatype migrate                 # Run pending migrations
supatype generate                # Re-generate TypeScript types

# Database
supatype db seed                 # Run seed files
supatype db reset                # Drop + recreate + migrate + seed

# Deployment
supatype deploy                  # Deploy to production
supatype cloud                   # Manage cloud environments
supatype self-host               # Self-hosting utilities

# Operations
supatype status                  # Check database connection and config
supatype logs                    # Tail server logs
supatype keys                    # Rotate/inspect JWT keys
supatype functions               # Manage edge functions
supatype plugins                 # Install/remove plugins
```

### Configuration

```typescript
// supatype.config.ts
export default {
  database: {
    url: process.env.DATABASE_URL,
  },
  schema: {
    path: "./schema",
  },
  storage: {
    buckets: ["images", "files", "avatars"],
  },
  auth: {
    enableMfa: true,
    mfaFactors: ["totp", "phone", "webauthn"],
  },
}
```

---

## Type Generation

After running `supatype push` or `supatype generate`, Supatype writes a fully-typed `Database` interface. Pass it to `createClient` and every query is type-safe with zero boilerplate:

```typescript
// Generated: types/database.ts (do not edit by hand)
export interface Database {
  public: {
    Tables: {
      posts: {
        Row: {
          id:           string
          title:        string
          slug:         string
          body:         string
          status:       "draft" | "published" | "archived"
          author_id:    string
          published_at: string | null
          created_at:   string
          updated_at:   string
          deleted_at:   string | null
        }
        Insert: {
          id?:          string
          title:        string
          slug?:        string   // auto-generated from title
          body:         string
          status?:      "draft" | "published" | "archived"
          author_id:    string
          published_at?: string | null
          created_at?:  string
          updated_at?:  string
        }
        Update: Partial<Database["public"]["Tables"]["posts"]["Insert"]>
      }
      // ...
    }
  }
}
```

---

## CMS

Supatype includes a full-featured, schema-driven CMS. The admin UI is auto-generated from your model definitions — no separate content type configuration required.

### Studio

The **Supatype Studio** is the built-in admin interface. It reads your compiled schema and renders a complete content management dashboard:

- **Collections** — paginated list view with search, sort, and filter; full edit form per record
- **Globals** — singleton editor for site-wide configuration (themes, nav menus, settings)
- **Media Library** — browse buckets, upload files, generate public/signed URLs, grid and list views
- **Dashboard** — configurable widgets showing record counts and recently-updated entries

The Studio requires no custom code. Add a model to your schema, push, and it appears in the sidebar.

### Draft / Publish Workflow

Use the `publishable()` composite to add a managed status field to any model:

```typescript
import { model, field, publishable } from "@supatype/schema"

const Post = model("post", {
  fields: {
    title:       field.text({ required: true }),
    body:        field.richText({ required: true }),
    publishInfo: publishable(), // Adds status, publishedAt, scheduledAt
  },
})
```

This adds three columns and a **Publish widget** in the Studio:

| Status | Allowed transitions |
|---|---|
| `draft` | → `published`, `scheduled` |
| `published` | → `archived`, `draft` |
| `scheduled` | → `draft`, `published` |
| `archived` | → `draft` |

Editors can schedule future publication by picking a date and time. The engine automatically promotes `scheduled` records to `published` at the specified time.

### Versioning

Enable full change history on any model:

```typescript
const Page = model("page", {
  fields: { /* ... */ },
  options: { versioning: true },
})
```

The engine creates a `{model}_versions` table capturing a complete snapshot on every save. In the Studio, editors can:

- Browse the full version timeline with timestamps
- Compare any version to the current state
- Restore a previous version with one click

### Block / Page Builder

Compose flexible page layouts using typed blocks:

```typescript
import { model, field, block, access } from "@supatype/schema"

const HeroBlock = block("hero", {
  label: "Hero Section",
  icon:  "layout",
  fields: {
    heading:  field.text({ required: true }),
    subtext:  field.text(),
    image:    field.image(),
    ctaLabel: field.text(),
    ctaUrl:   field.url(),
  },
})

const RichTextBlock = block("richText", {
  label:  "Rich Text",
  icon:   "type",
  fields: { body: field.richText({ required: true }) },
})

const Page = model("page", {
  fields: {
    title:   field.text({ required: true }),
    slug:    field.slug({ from: "title" }),
    content: field.blocks([HeroBlock, RichTextBlock], { maxNestingDepth: 3 }),
  },
  access: {
    read:   access.public(),
    create: access.role("editor", "admin"),
    update: access.role("editor", "admin"),
    delete: access.role("admin"),
  },
})
```

The Studio renders a drag-and-drop block editor — add, reorder, duplicate, and remove blocks, with a dedicated edit form for each block's fields.

### Localization

Mark any text, rich text, or JSON field as localized and Supatype stores a translation per locale:

```typescript
const Article = model("article", {
  fields: {
    title:   field.text({ required: true, localized: true }),
    body:    field.richText({ required: true, localized: true }),
    slug:    field.slug({ from: "title" }),       // not localized — one canonical slug
    author:  relation.belongsTo("user"),
  },
})
```

Configure available locales in your schema config:

```typescript
// supatype.config.ts
export default {
  locales: {
    locales:       ["en", "fr", "de", "es"],
    defaultLocale: "en",
    fallbackChains: {
      "fr-CA": ["fr", "en"],
    },
  },
}
```

In the Studio, a locale picker appears in the edit form. Localized fields show one input per locale. The client accepts a `.locale()` modifier to fetch translations:

```typescript
const { data } = await client
  .from("articles")
  .select("title, body")
  .eq("id", articleId)
  .locale("fr")
```

### Live Preview

Configure a preview URL per model and the Studio opens a live iframe that updates on every keystroke:

```typescript
// supatype.config.ts
export default {
  admin: {
    livePreview: {
      post: {
        url:        "https://localhost:3000/blog/{slug}",
        urlPattern: "/blog/{slug}",
      },
    },
  },
}
```

The preview pane syncs form state via `postMessage`. In your frontend, consume it with `useLivePreview`:

```tsx
import { useLivePreview } from "@supatype/react"

export default function PostPreview({ id }: { id: string }) {
  const { data: post, loading } = useLivePreview("post", id)

  if (loading) return null
  return (
    <article>
      <h1>{post.title}</h1>
      <div dangerouslySetInnerHTML={{ __html: post.body }} />
    </article>
  )
}
```

### Media Library

The Studio includes a full asset manager backed by Supatype Storage. Editors can:

- Upload files via drag-and-drop or file picker
- Navigate bucket folders with breadcrumb navigation
- Switch between grid and list views
- Search and filter by name
- Delete files and copy public URLs

Image fields in the edit form open the Media Library as a picker, keeping assets organised across all models.

### Globals

Globals are CMS singletons — tables with exactly one row, ideal for site configuration:

```typescript
import { global, field, access } from "@supatype/schema"

export const SiteSettings = global("siteSettings", {
  fields: {
    siteName:      field.text({ required: true }),
    logo:          field.image({ bucket: "branding" }),
    footerHtml:    field.richText(),
    defaultLocale: field.text({ required: true }),
    maintenance:   field.boolean(),
  },
  access: {
    read:   access.public(),
    update: access.role("admin"),
  },
})
```

Globals appear in the Studio sidebar under a "Globals" section and render a single edit form (no list view). Query them via the client:

```typescript
const { data: settings } = await client.global<SiteSettings>("siteSettings").get()
await client.global("siteSettings").update({ maintenance: true })
```

### Admin User Management

```bash
# Create an admin user
supatype admin create-user \
  --email admin@example.com \
  --password hunter2 \
  --role admin

# Change a user's role
supatype admin set-role \
  --email editor@example.com \
  --role editor
```

---

## Framework Integrations

| Package | Status |
|---|---|
| `@supatype/react` | Stable |
| `@supatype/vue` | Available |
| `@supatype/svelte` | Available |
| `@supatype/solid` | Available |

All framework packages expose the same hook patterns (`useQuery`, `useMutation`, `useAuth`, etc.) adapted to each framework's reactivity model.

---

## Plugin System

Extend Supatype via the plugin SDK:

```typescript
import { definePlugin } from "@supatype/plugin-sdk"

export default definePlugin({
  name: "audit-log",
  version: "1.0.0",
  setup({ schema, hooks }) {
    hooks.afterChange("*", async (event) => {
      await schema.from("audit_log").insert({
        table:      event.table,
        action:     event.operation,
        user_id:    event.session?.userId,
        changed_at: new Date().toISOString(),
        diff:       event.diff,
      })
    })
  },
})
```

---

## Self-Hosting

Supatype is designed to run anywhere Postgres runs:

```bash
supatype self-host init
```

Or deploy with Docker:

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: password

  supatype:
    image: supatype/engine:latest
    environment:
      DATABASE_URL: postgresql://postgres:password@db:5432/app
      JWT_SECRET: your-jwt-secret
    ports:
      - "3000:3000"
    depends_on:
      - db
```

---

## Monorepo Development

This repo uses [Turborepo](https://turbo.build/) + [pnpm workspaces](https://pnpm.io/workspaces).

```bash
# Install all dependencies
pnpm install

# Build all packages
pnpm build

# Type-check all packages
pnpm turbo run typecheck

# Test a specific package
pnpm --filter @supatype/schema test
pnpm --filter @supatype/client test
pnpm --filter @supatype/react test

# Watch mode for development
pnpm dev
```

### Package structure

```
supatype/
├── packages/
│   ├── schema/       @supatype/schema
│   ├── client/       @supatype/client
│   ├── react/        @supatype/react
│   ├── vue/          @supatype/vue
│   ├── svelte/       @supatype/svelte
│   ├── solid/        @supatype/solid
│   ├── cli/          @supatype/cli
│   ├── studio/       Admin UI
│   ├── common/       Shared utilities
│   └── plugin-sdk/   Plugin system
├── examples/
│   └── blog/         Next.js blog example
└── plans/            Phase planning docs
```

---

## License

MIT
