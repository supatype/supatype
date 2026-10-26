---
name: supatype
description: >-
  Guides working with Supatype: project setup, supatype.config.ts,
  schema/index.ts, CLI (dev, push, diff, generate), generated types,
  @supatype/client integration, and self-host. Use when the user mentions
  Supatype or is building on the Supatype stack.
---

# Supatype

Guide for working with Supatype projects. If unsure about a command or flag, run `supatype --help` (or `supatype <command> --help`): published docs may lag the installed CLI.

## Quick reference

| Topic | Reference |
|-------|-----------|
| Config and `.env` | [references/config.md](references/config.md) |
| Schema and access rules | [references/schema.md](references/schema.md) |
| CLI commands | [references/cli.md](references/cli.md) |
| Seeding | [references/seeding.md](references/seeding.md) |
| Frontend, client, React hooks + auth components | [references/frontend.md](references/frontend.md) |
| REST GET caching (client + server) | [references/caching.md](references/caching.md) |
| Self-host production | [references/self-host.md](references/self-host.md) |

## Prerequisites

Node.js 18+, Docker (default provider), npm/pnpm/yarn.

## New project

```bash
npx @supatype/cli init <project-name> --mode standalone  # self-host target
cd <project-name>
npm install                                # only if init skipped the install
supatype keys                              # only if init skipped the keys: ANON_KEY + SERVICE_ROLE_KEY in .env
supatype dev                               # terminal 1: Docker Compose (Kong :18473); applies the schema and watches it
npm run vite                               # terminal 2: if app.vite_dev_url is set
```

`supatype dev` keeps running. It pushes the schema when it starts and on every save, and
regenerates the typed client each time; there is no separate `push` step locally. `push` is for
another database: `supatype push --env <name>`, or a linked target.

It also stops, and stops its stack the way Ctrl+C does, within a few seconds of the process that
started it exiting: a script that was killed, a cancelled CI job, an agent's command that timed out.
So start it in the foreground, or from a process that stays alive. To leave a stack running with
nothing attached, use `supatype self-host compose up -d` instead. A script that backgrounds it
should `exec` it, `(cd app && exec npx supatype dev) &`, so `$!` is `dev` itself.

To run a second stack of the same project (another checkout, a test run), set
`SUPATYPE_PROJECT_NAME=<name>` or pass `--project-name <name>`, with its own `SUPATYPE_KONG_PORT`:
the compose project and the database follow the name for that run, and no file is written.

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

**Scaffold reference:** `supatype init --mode standalone` (static + `vite_dev_url`). Reference fixture: [`examples/self-host/`](https://github.com/supatype/supatype/tree/main/examples/self-host) in the Supatype repository. See [references/frontend.md](references/frontend.md).

## Daily workflow

1. Edit `schema/index.ts` (source of truth: type-first, not DB introspection)
2. With `supatype dev` running, saving applies the change and regenerates types
3. `supatype diff --env <name>` then `supatype push --env <name>`: apply it to another database
4. Renaming a field or model: record it with `supatype rename <table>.<old> <table>.<new>` (or
   `supatype rename <old_table> <new_table>`) and commit `supatype/renames.json`. Renames are
   never guessed; an unrecorded rename is a drop plus an add, which loses the column's data
5. Use generated types with `@supatype/client` in app code

## Core facts

- **Default provider:** `"docker"`, scaffolded in `supatype.config.ts` and used when no provider is set
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

Add `@supatype/client` when wiring a frontend. `supatype dev` applies schema changes locally as you save; `supatype push --env <name>` applies them elsewhere.

**Prefer first-party framework bindings over the raw client.** For React use `@supatype/react` (`SupatypeProvider`, `useAuth`, `useQuery`, `useMutation`, `useSubscription`) and `@supatype/react-auth` (`LoginForm`, `SignUpForm`, `OAuthButton`); equivalents exist for Vue/Solid/Svelte, plus `@supatype/ssr` for server rendering. Don't hand-roll auth forms or auth state. See [references/frontend.md](references/frontend.md).

## Common failures

| Error | Fix |
|-------|-----|
| Docker not running | Start Docker before `supatype dev` |
| Port in use | `supatype dev` prompts for another port, or set a unique `SUPATYPE_KONG_PORT` per project in `.env` |
| Wrong project / holding page | Another stack may own your Kong port; use the URL from `supatype dev` output |
| Docker still running after dev | Run `supatype self-host compose down`; check Docker Desktop for orphaned `supatype-*` stacks |
| Renamed project, old containers | Next `supatype dev` offers to stop the old stack; or `docker compose -p supatype-<old-name> down` |
| Missing JWT keys | `supatype keys --write` |
| `JWT_SECRET in .env is <n> characters, and the REST API needs at least 32.` | Put a longer secret in `.env` (`openssl rand -base64 48`), then `supatype keys --write --force` |
| REST answers `503` / `PGRST002` on a fresh self-host stack | Expected until the first `supatype push`; push waits up to 40 s for REST to load the schema |
| ``The process that started `supatype dev` has exited, so dev is stopping its stack.`` | The starter (script, CI step, agent command) exited. Keep `dev` in the foreground, or use `supatype self-host compose up -d` |
| `.env` change not picked up by a running stack | `supatype self-host compose restart <service>` (not `docker compose restart`) |
| No supatype.config.ts | `supatype init` |
| Types out of sync | `supatype push` or `supatype generate` |
| Destructive migration blocked | Review `supatype diff`; use `supatype push --yes` if intended |
| `SupatypeClient<Database>` not assignable to `SupatypeClient<any>` | Version skew between app's `@supatype/client` and the one `@supatype/react`(-auth) pulls; add npm `overrides: { "@supatype/client": "$@supatype/client" }` |

## When to read references

- **Schema design, access, relations, buckets** → [references/schema.md](references/schema.md)
- **Command flags and workflow** → [references/cli.md](references/cli.md)
- **Seed data, the ledger, `runOnce`** → [references/seeding.md](references/seeding.md)
- **Astro/Vite/Next wiring, React hooks, auth UI components** → [references/frontend.md](references/frontend.md)
- **Production compose** → [references/self-host.md](references/self-host.md)
