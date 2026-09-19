# Self-host production

Docker provider is the default scaffold and required for production self-host.

## Control plane

Self-hosted stacks include a **control-plane sidecar** (`supatype/control-plane`) that exposes schema, functions, deployments, and status APIs at `/platform/v1`. Kong routes authenticated requests through `supatype-server`, which proxies to the sidecar using `SERVICE_ROLE_KEY`.

Link a project for remote ops (same CLI commands as cloud):

```bash
supatype link --url https://app.example.com --token $SERVICE_ROLE_KEY
supatype link --env staging --url https://staging.example.com --token $SERVICE_ROLE_KEY
supatype push --env staging
supatype status --env staging
```

For local dev, `supatype dev` writes `.supatype/environment.json` with the Kong URL and database connection. `supatype push` uses the control plane automatically when that file exists.

## Local dev (Docker)

```bash
supatype keys          # if keys not in .env
supatype dev           # Compose stack + control-plane; Kong on :18473
supatype push          # → /platform/v1/.../schema/push via server auth
supatype status        # local services or linked target summary
```

`supatype dev` renders compose, starts services, and may write `SUPATYPE_KONG_PORT`, `SUPATYPE_DEV_DB_PORT`, and `.supatype/environment.json` to the project.

Use `--direct` on schema commands to bypass the control plane and invoke the local engine subprocess directly.

## Static frontend in compose

```bash
supatype app add --static ./public   # or configure app.mode in config
npm run build                        # write assets to static_dir
supatype self-host compose render
supatype self-host compose up -d
supatype self-host compose status
supatype deploy                      # uploads to control-plane when linked
```

## Production compose workflow

```bash
supatype self-host compose render    # write docker-compose.yml (includes control-plane)
supatype self-host compose up -d     # start production stack
supatype self-host compose down      # stop
supatype self-host compose status    # health check
```

## Custom domain + automatic HTTPS

Add a domain at any time with one command (interactive prompts for the domain and a Let's Encrypt email):

```bash
supatype add domain                 # prompts for domain + TLS email
supatype add domain demo.example.com --email you@example.com   # non-interactive
```

This sets `server.mode = "standalone"`, `server.domain`, and `server.tls` in `supatype.config.ts`:

```typescript
server: {
  mode: "standalone",
  domain: "demo.example.com",
  tls: { email: "you@example.com", provider: "kong" },
},
```

Then bring the stack up — compose and Kong are re-rendered from config on every run:

```bash
supatype self-host compose up -d
```

When `mode = "standalone"` + `domain` + `tls.email` are all set, the generated stack:

- publishes **Kong on `:80` and `:443`** (instead of the local `:18473`),
- adds the RESP cert store the `acme` plugin needs — a **Valkey** service by default (persisted in the `valkey-data` volume), or the `db` container itself when `cache.provider` is `pg_keyspace` (see below),
- enables Kong's global **`acme`** plugin, which provisions a Let's Encrypt certificate on the first HTTPS request and auto-renews it.

Prerequisites: point the domain's DNS **A record** at the server's public IP and open ports **80** and **443** (HTTP-01 challenge needs `:80`). Everything — your app, REST, Auth, Storage, Realtime, Functions, and Studio — is then served behind `https://<domain>`.

Set `server.tls.provider = "none"` to keep a domain configured but stay on plain HTTP.

> A `supatype.local.config.ts` override with `server: { mode: "dev" }` keeps local `supatype dev` on HTTP. That file is gitignored, so HTTPS still activates on the production server where it does not exist.

## Cache provider: Valkey or pg_keyspace

The REST response cache and Kong's ACME certificates both speak RESP, so the
stack needs one RESP server. By default that is a Valkey sidecar. It can
instead be `pg_keyspace`, the RESP keyspace inside the Postgres container, so
the stack runs one stateful service rather than two:

```ts
cache: { provider: "pg_keyspace" },
```

The `db` service is then started with `pg_keyspace` in
`shared_preload_libraries` (before `supatype_mask`, which has to stay
outermost), serving RESP on `db:6379`; the `valkey` service and its volume are
not generated, and both the server and Kong are pointed at `db`.

**Durability is `durable` for every key by default.** That is parity with the
Valkey sidecar it replaces, which runs `--appendonly yes` — the whole keyspace
is already persisted today. What changes is that it no longer has to be:

```ts
cache: {
  provider: "pg_keyspace",
  ephemeralPrefixes: ["rest:"],
},
```

Keys under a listed prefix stay in shared memory instead of going through the
WAL, which is what makes a response cache free to write. Everything not listed
stays durable, so Kong's certificates need no entry — the default is the safe
direction to be wrong in. See `pg_keyspace.durability_overrides` in the
[pg_keyspace README](https://github.com/supatype/postgres/tree/develop/extensions/pg_keyspace).

`cache.provider = "pg_keyspace"` is rejected with `database.external`: it is
loaded through `shared_preload_libraries`, which is not something Supatype can
set on a Postgres it does not start.

## Standalone mode (native TLS)

`mode = "standalone"` also drives the native (non-Compose) path, which serves ACME TLS directly from the host `supatype-server` binary. `supatype init --mode standalone` scaffolds this. Uses host binaries, not Docker Compose.

## Package.json scripts (typical)

```json
{
  "scripts": {
    "dev": "supatype dev",
    "push": "supatype push",
    "selfhost:render": "supatype self-host compose render",
    "selfhost:up": "supatype self-host compose up -d",
    "selfhost:down": "supatype self-host compose down",
    "selfhost:status": "supatype self-host compose status"
  }
}
```

## Maintainer example

See `examples/self-host/` in the supatype monorepo for a compose-first fixture with proxy app mode.
