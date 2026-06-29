<p align="center">
  <img src="https://raw.githubusercontent.com/supatype/.github/refs/heads/main/profile/supatype-icon.svg" width="60" alt="Supatype" />
</p>

# @supatype/cli

CLI for [Supatype](https://github.com/supatype/supatype) — push schema changes, generate typed clients, run migrations, and manage your Supatype project.

## Installation

```bash
npm i -g @supatype/cli
# or per-project
npm i -D @supatype/cli
```

## Quick start

```bash
# Initialise a new project
supatype init

# Start local dev server
supatype dev

# Compare your types to the live schema
supatype diff

# Push schema changes to Postgres
supatype push

# Generate typed client bindings
supatype generate
```

## Schema workflow

Define your schema using `@supatype/types` in `supatype.config.ts`:

```ts
import type { Model, UUID, Email, Slug, RichText, Optional, RelatedTo, HasMany, Timestamps, LoggedIn, Owner } from "@supatype/types"

export type Author = Model<{
  id: UUID
  name: string
  email: Email
  posts: HasMany<Post>
} & Timestamps>

export type Post = Model<
  {
    id: UUID
    slug: Slug
    title: string
    body: RichText
    author: RelatedTo<Author>
  } & Timestamps,
  { access: { read: LoggedIn; create: Owner<"author_id"> } }
>
```

Then run:

```bash
supatype diff      # preview SQL changes
supatype push      # apply to Postgres
supatype generate  # emit Database type + typed client
```

## Commands

| Command | Description |
|---------|-------------|
| `supatype init` | Scaffold `supatype.config.ts` and project config |
| `supatype dev` | Start local Postgres + Supatype server |
| `supatype diff` | Show pending schema changes as SQL |
| `supatype push` | Apply schema changes to the database |
| `supatype pull` | Introspect an existing database into types |
| `supatype generate` | Generate `Database` TypeScript types and client bindings |
| `supatype migrate` | Run raw SQL migration files |
| `supatype seed` | Run seed files |
| `supatype introspect` | Dump the current DB schema |
| `supatype status` | Show connection and project status |
| `supatype doctor` | Diagnose common setup issues |
| `supatype functions` | Manage edge functions |
| `supatype deploy` | Deploy your project |
| `supatype self-host` | Manage self-hosted Supatype (Docker Compose) |
| `supatype keys` | Manage API keys |
| `supatype logs` | Stream server logs |
| `supatype update` | Update Supatype binaries |
| `supatype cache` | Manage the binary cache |

## Local dev

```bash
supatype dev                   # start native Postgres + engine
supatype dev --docker-postgres # use Docker for Postgres only
```

## Self-hosting

```bash
supatype self-host compose up    # start all services via Docker Compose
supatype self-host compose down
```

## Binary cache

```bash
supatype update        # download latest engine binaries
supatype cache list    # show cached versions
```

## Configuration

Override local settings with `supatype.local.config.ts` (gitignored, deep-merged):

```ts
// supatype.local.config.ts
export default {
  db: { url: "postgresql://localhost:5432/myapp_dev" },
}
```

## Docs

Full documentation: [supatype.github.io/supatype](https://supatype.github.io/supatype/)
