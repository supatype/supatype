<p align="center">
   <img src="https://raw.githubusercontent.com/supatype/.github/refs/heads/main/profile/supatype-icon.svg" width="80" alt="Supatype" />
</p>

# Supatype — Local development

**Supatype** is a schema-first backend for **PostgreSQL**. You describe tables, relations, access rules, and storage in **TypeScript** (`@supatype/types`); the **schema engine** turns that into migrations, RLS, triggers, and admin metadata; the **`supatype` CLI** wires local dev, binary downloads, and project config.

In production and in local dev, **`supatype-server`** is the **unified HTTP gateway**: it fronts **PostgREST** (`/rest/v1/`), **authentication** (`/auth/v1/`), **storage** (`/storage/v1/`), **Realtime** (`/realtime/v1/`), and related APIs on one port. You do not run a separate “auth service” binary for normal development—the paths stay familiar, but the process you run and ship is **supatype-server**.

This repository is the **open-source monorepo** (`@supatype/cli`, `@supatype/client`, `@supatype/react`, Studio, storage, realtime, etc.). Use the sections below to hack on the toolchain or to bootstrap a new app from `supatype init`.

---

## Prerequisites

- **Node.js** 22+ (matches CI; older LTS may work but is not what we test against)
- **pnpm** 10+ (`npm i -g pnpm`)
- **Docker** (default Postgres provider — Docker Desktop or equivalent)

> If you prefer a native Postgres binary instead of Docker, set `database.provider` to `"native"` in `supatype.config.ts`. The CLI will download and manage the binary for you.

---

## First-time setup (new project)

```sh
# Install dependencies in this monorepo
pnpm install

# Scaffold a new project in the current directory
pnpm supatype init

# Or scaffold into a new subdirectory
pnpm supatype init my-app
```

`supatype init` creates:

| File | Purpose |
|---|---|
| `supatype.config.ts` | Project config (DB provider, server port, versions) |
| `schema/index.ts` | Your schema entry point |
| `.env` | Local secrets (DB URL, JWT keys, SMTP) |
| `seed.ts` | Seed script |
| `.gitignore` | Pre-configured to exclude `.env`, binaries, generated files |

`supatype init` does **not** write a `package.json`. In a new folder you still need one (with `@supatype/cli`, and `@supatype/types` for schema authoring) before `pnpm install` / `pnpm supatype dev` will work. Cloning the monorepo or copying an example app already satisfies that.

---

## Starting local dev

```sh
pnpm supatype dev
```

This single command:
1. Pulls and starts **Postgres** (via Docker on port 5432)
2. Downloads the **engine** and **server** binaries if not cached
3. Applies your **schema** to the database
4. Starts **supatype-server** (the unified API gateway)
5. Watches the **directory containing your schema entry** (default: `schema/`) for `.ts` changes and re-applies automatically

Once running, **HTTP and WebSocket routes below share one process: `supatype-server`** (default `http://localhost:54321`; change with `supatype dev --port`).

| Route / capability | URL |
|---|---|
| REST (PostgREST) | `http://localhost:54321/rest/v1/` |
| Authentication | `http://localhost:54321/auth/v1/` |
| Storage | `http://localhost:54321/storage/v1/` |
| Realtime | `ws://localhost:54321/realtime/v1/` |
| Postgres (default **docker** image) | `postgresql://supatype_admin:postgres@localhost:5432/<project>` (same as `.env` from `supatype init`) |
| Postgres (**native** `database.provider`) | `postgresql://postgres:postgres@127.0.0.1:5432/<project>` |

Press `Ctrl+C` to stop everything cleanly.

### Options

```sh
supatype dev --no-watch     # Start services but skip schema file watching
supatype dev --port 8080    # Override the server port
```

---

## Schema workflow

Edit `schema/index.ts` (or any file it imports). The `dev` watcher re-applies changes automatically. For explicit control:

```sh
# Show planned changes without applying (dry run)
supatype diff

# Apply schema to DB + regenerate TypeScript types
supatype push

# Regenerate types only (no migration)
supatype generate
```

`supatype push` prints a change summary with risk levels:

```
[+] CREATE TABLE posts        (safe)
[~] ALTER COLUMN body         (caution)
[!] DROP COLUMN legacy_field  (DANGER)
```

Destructive changes require confirmation unless you pass `--yes`.

---

## Migrations

```sh
supatype migrate     # Apply all pending migrations
supatype rollback    # Undo the last applied migration
supatype reset       # Drop all managed tables and re-apply from scratch (destructive)
```

---

## Service status

```sh
supatype status
```

Shows which services are running, their ports, and uptime.

---

## JWT keys

```sh
supatype keys
```

Generates `ANON_KEY` and `SERVICE_ROLE_KEY` for your `.env`. Run this once after `supatype init`.

---

## Postgres management (native provider only)

When `database.provider` is `"native"` in config:

```sh
supatype pg start         # Start Postgres
supatype pg stop          # Stop Postgres
supatype pg reset         # Wipe data directory and re-initialise
supatype pg psql          # Open a psql shell
```

---

## Binary cache

The CLI downloads engine, server, Postgres, and Deno binaries and caches them in `~/.supatype/`.

```sh
supatype update           # Download latest versions defined in supatype.config.ts
supatype cache list       # Show cached binaries
supatype cache clean      # Remove all cached binaries
```

---

## Local binary overrides (dev on this repo)

To point the CLI at local builds (e.g. when working on `supatype-schema-engine`), create `supatype.local.config.ts` alongside your `supatype.config.ts`. This file is gitignored.

```ts
// supatype.local.config.ts
import type { SupatypeProjectConfig } from "@supatype/cli"
const local: Partial<SupatypeProjectConfig> = {
  overrides: {
    engine: "/path/to/supatype-schema-engine/target/release/supatype-engine",
    server: "/path/to/supatype-auth/supatype-server",
    // postgres_dir: "/path/to/local/pg",
  },
}
export default local
```

When an override is set, the corresponding CDN version is ignored entirely. Setting both a version pin and an override for the same binary is an error.

---

## Running CLI commands in this monorepo

Within this repo, the CLI isn't globally installed. Use the root `pnpm supatype` shortcut instead of `npx supatype`:

```sh
pnpm supatype dev
pnpm supatype push
pnpm supatype diff
```

---

## Useful dev commands (monorepo)

```sh
pnpm build                       # Build all packages
pnpm turbo run typecheck         # Type-check all packages
pnpm --filter @supatype/cli test # Run CLI tests
pnpm --filter @supatype/client test
```
