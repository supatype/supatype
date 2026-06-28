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
  email: { provider: "console" },
  storage: { provider: "local", local_path: ".supatype/storage" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
})
```

**Docker images:** omit `versions` so compose defaults to `:latest` (`supatype/server:latest`, `supatype/schema-engine:latest`, etc.). Pin `versions.*` only when you need a specific release.

## Self-host scaffold (`supatype init --mode standalone`)

End-user layout from `supatype init --mode standalone` (maintainer compose fixture: **`examples/self-host/`**):

```typescript
export default defineConfig({
  project: { name: "my-project" },
  provider: "docker",
  database: { provider: "docker" },
  server: {
    mode: "standalone",
    port: 54321,
    domain: "demo.supatype.com",
    tls: { email: "you@example.com", provider: "kong" },
  },
  app: {
    mode: "static",
    static_dir: "./dist",
    vite_dev_url: "http://127.0.0.1:5173",
  },
  environments: { default: "production" },
  email: { provider: "console" },
  storage: { provider: "local", local_path: ".supatype/storage" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
})
```

Keep local HTTP in `supatype.local.config.ts`:

```typescript
export default { server: { mode: "dev" } }
```

## Key fields

| Field | Notes |
|-------|-------|
| `provider` | Top-level runtime: `"docker"` (default scaffold) or `"native"` |
| `database.provider` | Same values; used when `provider` omitted |
| `server.mode` | `"dev"`, `"standalone"` (self-host with HTTPS), or `"managed"` (cloud) |
| `server.port` | supatype-server port (native dev) |
| `server.domain` | Custom domain for self-host HTTPS (e.g. `"demo.example.com"`) |
| `server.tls` | `{ email, provider }` — Let's Encrypt contact email; `provider: "kong"` (default, Kong ACME) or `"none"` (stay HTTP). Set via `supatype add domain` |
| `app.mode` | `"none"`, `"static"`, or `"proxy"` |
| `app.static_dir` | Built static assets directory |
| `app.vite_dev_url` | Vite dev server URL for HMR (`/_vite/*`) when using **static** mode locally — e.g. `http://127.0.0.1:5173`. Sets `SUPATYPE_VITE_DEV_URL` during `supatype dev` |
| `app.upstream` | Proxy target for SSR/dev servers (proxy mode) |
| `app.start` | package.json script name to run in proxy mode (e.g. `"vite"`) |
| `output.types` | Generated TypeScript types path |
| `build` | Framework build integration for `supatype deploy` (`framework`, `buildCommand`, `outputDirectory`, `env`) |
| `versions.*` | Optional pin for engine, server, postgres, deno — **omit for Docker `:latest`** |
| `connection` | Override database URL (else `DATABASE_URL` env) |

## .env essentials

```bash
DATABASE_URL=postgresql://supatype_admin:postgres@localhost:5432/my-project
JWT_SECRET=super-secret-jwt-token-change-in-production
ANON_KEY=           # from: supatype keys
SERVICE_ROLE_KEY=   # from: supatype keys — also used as self-host control-plane token
SITE_URL=http://localhost:18473
VITE_SUPATYPE_ANON_KEY=   # copy from ANON_KEY for Vite builds / dev

# Written by supatype dev (docker):
# SUPATYPE_KONG_PORT=18473
# SUPATYPE_DEV_DB_PORT=54329
```

Do **not** set `SUPATYPE_*_IMAGE` env vars unless overriding — pinned image tags in `.env` override compose `:latest` defaults.

## Link and environment files

| File | Purpose |
|------|---------|
| `.supatype/link.json` | Unified link state: cloud or self-host targets, tokens, environments map |
| `.supatype/environment.json` | Written by `supatype dev` — local Kong URL, DB URL, project ref |
| `.supatype/branch.json` | Phase 22 hook for ephemeral branch targets (not active in v1) |

Add `.supatype/` to `.gitignore` (done by `supatype init`; use `supatype link --fix-gitignore` if missing). Never commit `link.json` — it contains tokens.

`supatype.config.ts` supports optional multi-env defaults:

```typescript
environments: {
  default: "production",
  branchDefaults: { "feature/foo": "staging" },
},
```

For Docker dev, `supatype dev` may rewrite `DATABASE_URL` to the host-published compose Postgres port when using a local engine override.

## Self-host HTTPS (custom domain)

`supatype add domain` writes this block; the self-host compose stack then publishes Kong on `:80`/`:443`, adds a Valkey cert store, and issues a Let's Encrypt certificate automatically:

```typescript
server: {
  mode: "standalone",
  domain: "demo.example.com",
  tls: { email: "you@example.com", provider: "kong" },
},
```

Apply with `supatype self-host compose up -d`. Keep a `supatype.local.config.ts` with `server: { mode: "dev" }` and **app proxy** for Vite local dev:

```typescript
export default {
  server: { mode: "dev" },
  app: {
    mode: "proxy",
    upstream: "http://127.0.0.1:5173",
    start: "vite",
    vite_dev_url: "http://127.0.0.1:5173",
  },
}
```

Committed `supatype.config.ts` stays `app.mode: "static"` for production.

## Switching to native dev

```typescript
export default defineConfig({
  provider: "native",
  database: { provider: "native" },
  // ...
})
```

Requires no Docker. Uses host Postgres on :5432 and supatype-server on `server.port` (default 54321).
