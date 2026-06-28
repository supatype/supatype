---
name: supatype
description: >-
  Guides working with Supatype: project setup, supatype.config.ts,
  schema/index.ts, CLI (dev, push, diff, generate), generated types,
  @supatype/client integration, and self-host. Use when the user mentions
  Supatype or is building on the Supatype stack.
---

# Supatype

Guide for working with Supatype projects. If unsure about a command or flag, run `supatype --help` (or `supatype <command> --help`) — published docs may lag the installed CLI.

## Quick reference

| Topic | Reference |
|-------|-----------|
| Config and `.env` | [references/config.md](references/config.md) |
| Schema and access rules | [references/schema.md](references/schema.md) |
| CLI commands | [references/cli.md](references/cli.md) |
| Frontend, client, React hooks + auth components | [references/frontend.md](references/frontend.md) |
| REST GET caching (client + Valkey) | [references/caching.md](references/caching.md) |
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

Install matching versions of CLI, client, and types from npm:

```bash
npm view @supatype/cli dist-tags    # compare latest vs alpha
npm install @supatype/cli@latest @supatype/client@latest @supatype/types@latest
```

Use `@alpha` only when the alpha tag is newer than `latest`:

```bash
npm install @supatype/cli@alpha @supatype/client@alpha @supatype/types@alpha
```

Pin all `@supatype/*` packages to the **same version** to avoid client/type skew.

Omit `versions` in `supatype.config.ts` so Docker pulls `:latest` images.

**Scaffold reference:** `supatype init --mode standalone` (static + `vite_dev_url`). Maintainer fixture: `examples/self-host/` in the Supatype monorepo. See [references/frontend.md](references/frontend.md).

## Daily workflow

1. Edit `schema/index.ts` (source of truth: type-first, not DB introspection)
2. `supatype diff`: preview changes
3. `supatype push`: apply migration + regenerate types
4. Use generated types with `@supatype/client` in app code

## Core facts

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

**Prefer first-party framework bindings over the raw client.** For React use `@supatype/react` (`SupatypeProvider`, `useAuth`, `useQuery`, `useMutation`, `useSubscription`) and `@supatype/react-auth` (`LoginForm`, `SignUpForm`, `OAuthButton`); equivalents exist for Vue/Solid/Svelte, plus `@supatype/ssr` for server rendering. Don't hand-roll auth forms or auth state. See [references/frontend.md](references/frontend.md).

## Common failures

| Error | Fix |
|-------|-----|
| Docker not running | Start Docker before `supatype dev` |
| Port in use | `supatype dev` prompts for another port, or set a unique `SUPATYPE_KONG_PORT` per project in `.env` |
| Wrong project / holding page | Another stack may own your Kong port — use the URL from `supatype dev` output |
| Docker still running after dev | Run `supatype self-host compose down`; check Docker Desktop for orphaned `supatype-*` stacks |
| Renamed project, old containers | Next `supatype dev` offers to stop the old stack; or `docker compose -p supatype-<old-name> down` |
| Missing JWT keys | `supatype keys` → update `.env` |
| No supatype.config.ts | `supatype init` |
| Types out of sync | `supatype push` or `supatype generate` |
| Destructive migration blocked | Review `supatype diff`; use `supatype push --yes` if intended |
| `SupatypeClient<Database>` not assignable to `SupatypeClient<any>` | Version skew between app's `@supatype/client` and the one `@supatype/react`(-auth) pulls; add npm `overrides: { "@supatype/client": "$@supatype/client" }` |

## When to read references

- **Schema design, access, relations, buckets** → [references/schema.md](references/schema.md)
- **Command flags and workflow** → [references/cli.md](references/cli.md)
- **Astro/Vite/Next wiring, React hooks, auth UI components** → [references/frontend.md](references/frontend.md)
- **Production compose** → [references/self-host.md](references/self-host.md)
