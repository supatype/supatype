---
name: supatype
description: >-
  Guides working with Supatype: project setup, supatype.config.ts,
  schema/index.ts, CLI (dev, push, diff, generate), generated types,
  @supatype/client integration, and self-host. Use when the user mentions
  Supatype or is building on the Supatype stack.
---

# Supatype

Guide for working with Supatype projects. **Verify against `packages/cli/src/commands/*.ts` when repo facts are uncertain**: public docs may lag the CLI.

## Quick reference

| Topic | Reference |
|-------|-----------|
| Config and `.env` | [references/config.md](references/config.md) |
| Schema and access rules | [references/schema.md](references/schema.md) |
| CLI commands | [references/cli.md](references/cli.md) |
| Frontend + client | [references/frontend.md](references/frontend.md) |
| Self-host production | [references/self-host.md](references/self-host.md) |

## Prerequisites

Node.js 18+, Docker (default provider), npm/pnpm/yarn.

## New project

```bash
npx @supatype/cli init <project-name> --mode standalone  # self-host target
cd <project-name>
npm install
supatype keys                              # → ANON_KEY + SERVICE_ROLE_KEY in .env
supatype push                              # migrate + generate types
supatype dev                               # terminal 1 — Docker Compose; Kong :18473
npm run vite                               # terminal 2 — if app.vite_dev_url is set
```

Supatype is in **early development**. For now, see what the latest alpha is on npm and install that:

```bash
npm view @supatype/cli versions   # pick the highest 0.1.0-alpha.*
npm install @supatype/cli@<version> @supatype/client@<version> @supatype/types@<version>
```

Omit `versions` in `supatype.config.ts` so Docker pulls `:latest` images.

**Reference app:** `test-app` in the Supatype monorepo — canonical self-host + static + `vite_dev_url` layout. See [references/frontend.md](references/frontend.md).

## Daily workflow

1. Edit `schema/index.ts` (source of truth: type-first, not DB introspection)
2. `supatype diff`: preview changes
3. `supatype push`: apply migration + regenerate types
4. Use generated types with `@supatype/client` in app code

## Core facts (CLI source)

- **Default provider:** `"docker"` in scaffolded `supatype.config.ts`
- **Native alternative:** `provider: "native"`: host Postgres :5432, supatype-server :54321
- **Schema API:** `@supatype/types` `Model<>` types, not `@supatype/schema`
- **Config:** `supatype.config.ts` + `defineConfig`; TOML unsupported
- **Docker API URL:** `http://localhost:18473` (or `SUPATYPE_KONG_PORT` in `.env`)
- **Types output:** `output: { types: "path/to/file.ts" }` in config
- **Local overrides:** `supatype.local.config.ts` (gitignored)

## Client usage

```typescript
import { createClient } from "@supatype/client"
import type { Database } from "./src/lib/database"

const supatype = createClient<Database>({
  url: process.env.PUBLIC_SUPATYPE_URL ?? "http://localhost:18473",
  anonKey: process.env.ANON_KEY!,
})

const { data } = await supatype.from("posts").select("*")
```

Add `@supatype/client` when wiring a frontend. Run `supatype push` after schema changes.

## Common failures

| Error | Fix |
|-------|-----|
| Docker not running | Start Docker before `supatype dev` |
| Port in use | Check `SUPATYPE_KONG_PORT`; stop other Supatype projects |
| Missing JWT keys | `supatype keys` → update `.env` |
| No supatype.config.ts | `supatype init` |
| Types out of sync | `supatype push` or `supatype generate` |
| Destructive migration blocked | Review `supatype diff`; use `supatype push --yes` if intended |

## When to read references

- **Schema design, access, relations, buckets** → [references/schema.md](references/schema.md)
- **Command flags and workflow** → [references/cli.md](references/cli.md)
- **Astro/Vite/Next wiring** → [references/frontend.md](references/frontend.md)
- **Production compose** → [references/self-host.md](references/self-host.md)
