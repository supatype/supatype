# CLI reference

Install: `npm install -g @supatype/cli` or use `npx @supatype/cli`.

Global flags (all commands): `--config`, `--env`, `--verbose`, `--json`, `--no-color`.

## Project lifecycle

| Command | Purpose |
|---------|---------|
| `supatype init [name]` | Scaffold project. Flags: `--mode dev \| standalone` |
| `supatype keys` | Generate `ANON_KEY` + `SERVICE_ROLE_KEY` from `JWT_SECRET` |
| `supatype dev` | Start local stack + control-plane. Docker default (Kong :18473). Flags: `--no-watch`, `--port` |
| `supatype push` | Diff, migrate, generate types. Flags: `--yes`, `--connection`, `--env`, `--direct` |
| `supatype diff` | Dry-run schema changes. Flags: `--connection`, `--env`, `--direct` |
| `supatype generate` | Regenerate types without migration |
| `supatype seed` | Run seed script |

## Linking (unified)

All targets use `.supatype/link.json` with an `environments` map:

| Command | Purpose |
|---------|---------|
| `supatype link --project <ref>` | Link to Supatype Cloud (uses platform access token) |
| `supatype link --url <api> --token <key>` | Link to self-host (`SERVICE_ROLE_KEY` from `supatype keys`) |
| `supatype link --env staging --url ... --token ...` | Add another environment |
| `supatype envs list` | List linked environments |
| `supatype envs use <name>` | Set default environment |
| `supatype envs create <name> --url ... --token ...` | Add environment to link.json |

Legacy `.supatype/cloud.json` and `.supatype/linked.json` migrate into `link.json` on first read.

Auth flag: `--token` (cloud = platform PAT; self-host = `SERVICE_ROLE_KEY`). `--service-role-key` is a deprecated alias.

## Schema and database

| Command | Purpose |
|---------|---------|
| `supatype doctor` | Schema drift report. Flags: `--env`, `--direct`, `--strict` |
| `supatype adopt` | Stamp managed comments on existing DB objects. Flags: `--env`, `--yes` |
| `supatype introspect` | Introspect live Postgres. Flags: `--env`, `--json`, `--direct` |
| `supatype migrate` | Migration utilities |
| `supatype rollback` | Undo the last applied migration (linked or direct). Flags: `--env`, `--connection`, `--direct`, `--sync-schema`, `--no-sync-schema` |
| `supatype migrations list` | List applied migrations with snapshot metadata. Flags: `--env`, `--connection`, `--direct` |
| `supatype db connection-string` | Show DB URL (cloud linked projects) |
| `supatype db reset-password` | Reset cloud project DB password |
| `supatype pg` | Postgres helpers |
| `supatype pull` | **Removed**: type-first mode uses `schema/index.ts` as source of truth |

## App and deploy

| Command | Purpose |
|---------|---------|
| `supatype app add` | Add static or proxy app to compose (e.g. `--static ./public`) |
| `supatype app remove` | Remove app from compose |
| `supatype add domain [domain]` | Add a custom domain with automatic HTTPS (self-host). Interactive, or pass `--email <addr>`. Sets `server.mode=standalone` + `domain` + `tls`; apply with `compose up -d` |
| `supatype self-host compose render` | Write docker-compose.yml |
| `supatype self-host compose up -d` | Start production stack |
| `supatype self-host compose down` | Stop stack |
| `supatype self-host compose status` | Health check |
| `supatype deploy` | Deploy schema + static app to linked target. Flags: `--local`, `--env`, `--schema-only` |
| `supatype deploy status` | Current static deployment |
| `supatype deploy rollback` | Roll back static deployment. Flags: `--env`, `--to <deployment-id>` |

## Functions and extensions

| Command | Purpose |
|---------|---------|
| `supatype functions deploy` | Deploy edge functions via control plane when linked |
| `supatype functions list` | List deployed functions |
| `supatype plugins` | Plugin scaffolding |
| `supatype types` | Type utilities |

## Ops and maintenance

| Command | Purpose |
|---------|---------|
| `supatype status` | Linked target summary or local dev stack health. Flag: `--env` |
| `supatype logs` | View logs |
| `supatype admin` | Admin user provisioning |
| `supatype update` | Update pinned component versions |
| `supatype cache` | Binary/image cache management |
| `supatype engine` | Schema engine utilities |

## Typical sequences

**First run:**
```bash
supatype init my-app && cd my-app
npm install && supatype keys
# paste keys into .env
supatype dev
supatype push
```

**Remote self-host (no local Postgres):**
```bash
supatype link --url https://app.example.com --token $SERVICE_ROLE_KEY
supatype push
supatype functions deploy
supatype deploy
supatype status
```

**Schema change:**
```bash
supatype diff
supatype push          # or: supatype push --yes
supatype push --direct # bypass control plane, use local engine
supatype migrations list --env staging
supatype rollback --env staging   # DB revert + optional schema file restore from DB snapshot
supatype rollback --no-sync-schema  # database only
```

**Rollback notes:** `supatype rollback` undoes exactly the last applied migration on the shared database. Schema source files can be restored from the gzip snapshot stored in `_supatype.migrations` (not from git). One-step undo only — older migrations require sequential rollbacks or a forward-fix migration.

**Self-host production:**
```bash
npm run build
supatype add domain demo.example.com --email you@example.com  # automatic HTTPS (Kong ACME)
supatype self-host compose up -d                              # publishes :80/:443, issues cert on first hit
supatype link --url https://demo.example.com --token $SERVICE_ROLE_KEY
supatype deploy
```

## Branch environments (Phase 22)

Ephemeral branch environments are not implemented in v1. Design hooks: `.supatype/branch.json` and `resolveTarget()` branch mode. Full PR preview provisioning is deferred to Phase 22.
