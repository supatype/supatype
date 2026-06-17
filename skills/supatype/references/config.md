# supatype.config.ts reference

Canonical config uses `defineConfig` from `@supatype/cli`. Optional `supatype.local.config.ts` merges on top (gitignored).

## Minimal scaffold (from `supatype init`)

```typescript
import { defineConfig } from "@supatype/cli"

export default defineConfig({
  project: { name: "my-project" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev", port: 54321 },
  app: { mode: "none" },
  versions: {
    engine: "latest",
    server: "latest",
    postgres: "latest",
    deno: "latest",
  },
  email: { provider: "console" },
  storage: { provider: "local", local_path: ".supatype/storage" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
})
```

## Key fields

| Field | Notes |
|-------|-------|
| `provider` | Top-level runtime: `"docker"` (default scaffold) or `"native"` |
| `database.provider` | Same values; used when `provider` omitted |
| `server.mode` | `"dev"` or `"standalone"` (native ACME TLS when domain set) |
| `server.port` | supatype-server port (native dev) |
| `app.mode` | `"none"`, `"static"`, or `"proxy"` |
| `app.static_dir` | Built static assets directory |
| `app.upstream` | Proxy target for SSR/dev servers |
| `app.start` | Command to run app in proxy mode (e.g. `"dev"`) |
| `output.types` | Generated TypeScript types path |
| `build` | Framework build integration (`framework`, `buildCommand`, `outputDirectory`, `env`) |
| `versions.*` | Pin engine, server, postgres, deno binary/image versions |
| `connection` | Override database URL (else `DATABASE_URL` env) |

## .env essentials

```bash
DATABASE_URL=postgresql://supatype_admin:postgres@localhost:5432/my-project
JWT_SECRET=super-secret-jwt-token-change-in-production
ANON_KEY=           # from: supatype keys
SERVICE_ROLE_KEY=   # from: supatype keys
SITE_URL=http://localhost:3000

# Written by supatype dev (docker):
# SUPATYPE_KONG_PORT=18473
# SUPATYPE_DEV_DB_PORT=54329
```

For Docker dev, `supatype dev` may rewrite `DATABASE_URL` to the host-published compose Postgres port when using a local engine override.

## Switching to native dev

```typescript
export default defineConfig({
  provider: "native",
  database: { provider: "native" },
  // ...
})
```

Requires no Docker. Uses host Postgres on :5432 and supatype-server on `server.port` (default 54321).
