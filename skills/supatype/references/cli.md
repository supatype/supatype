# CLI reference

Install: `npm install -g @supatype/cli` or use `npx @supatype/cli`.

Global flags (all commands): `--config`, `--env`, `--verbose`, `--json`, `--no-color`.

## Project lifecycle

| Command | Purpose |
|---------|---------|
| `supatype init [name]` | Scaffold project. Flags: `--mode dev \| standalone` |
| `supatype keys` | Generate `ANON_KEY` + `SERVICE_ROLE_KEY` from `JWT_SECRET` |
| `supatype dev` | Start local stack. Docker default (Kong :18473). Flags: `--no-watch`, `--port` |
| `supatype push` | Diff, migrate, generate types. Flags: `--yes`, `--connection` |
| `supatype diff` | Dry-run schema changes. Flag: `--connection` |
| `supatype generate` | Regenerate types without migration |
| `supatype seed` | Run seed script |

## Schema and database

| Command | Purpose |
|---------|---------|
| `supatype migrate` | Migration utilities |
| `supatype db` | Database management |
| `supatype pg` | Postgres helpers |
| `supatype pull` | **Removed**: type-first mode uses `schema/index.ts` as source of truth |

## App and deploy

| Command | Purpose |
|---------|---------|
| `supatype app add` | Add static or proxy app to compose (e.g. `--static ./public`) |
| `supatype app remove` | Remove app from compose |
| `supatype self-host compose render` | Write docker-compose.yml |
| `supatype self-host compose up -d` | Start production stack |
| `supatype self-host compose down` | Stop stack |
| `supatype self-host compose status` | Health check |
| `supatype deploy` | Deploy to linked cloud project |
| `supatype cloud` | Cloud project linking |

## Functions and extensions

| Command | Purpose |
|---------|---------|
| `supatype functions` | Scaffold/manage edge functions (Deno) |
| `supatype plugins` | Plugin scaffolding |
| `supatype types` | Type utilities |

## Ops and maintenance

| Command | Purpose |
|---------|---------|
| `supatype status` | Service status |
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

**Schema change:**
```bash
supatype diff
supatype push          # or: supatype push --yes
```

**Self-host production:**
```bash
npm run build
supatype self-host compose render
supatype self-host compose up -d
```

## Provider behavior

- **`provider: "docker"`** (default): `supatype dev` runs Compose stack; API via Kong
- **`provider: "native"`**: `supatype dev` runs host Postgres + supatype-server binaries

Resolved as: `config.provider ?? database.provider ?? "native"`.

## Output paths

Set in `supatype.config.ts`:

```typescript
output: {
  types: "src/lib/database.ts",
  client: "supatype/generated/index.d.ts",  // optional augmentation
}
```

Default types path if omitted: `types/database.ts`.
