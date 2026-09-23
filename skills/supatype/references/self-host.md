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
- adds the RESP cert store the `acme` plugin needs — served by the **`db` container itself** by default, or a **Valkey** service (persisted in the `valkey-data` volume) when `cache.provider` is `valkey` (see below),
- enables Kong's global **`acme`** plugin, which provisions a Let's Encrypt certificate on the first HTTPS request and auto-renews it.

Prerequisites: point the domain's DNS **A record** at the server's public IP and open ports **80** and **443** (HTTP-01 challenge needs `:80`). Everything — your app, REST, Auth, Storage, Realtime, Functions, and Studio — is then served behind `https://<domain>`.

Set `server.tls.provider = "none"` to keep a domain configured but stay on plain HTTP.

> A `supatype.local.config.ts` override with `server: { mode: "dev" }` keeps local `supatype dev` on HTTP. That file is gitignored, so HTTPS still activates on the production server where it does not exist.

## Cache provider: pg_keyspace or Valkey

The REST response cache and Kong's ACME certificates both speak RESP, so the
stack needs one RESP server. **By default that is `pg_keyspace`, inside the
Postgres container** — one stateful service instead of two, one image to keep
patched instead of two, and a cache whose memory is accounted for in the
database's own reservation.

The `db` service is started with the keyspace turned on
(`SUPATYPE_KEYSPACE_ENABLED=1`, which the image reads before any server
starts), serving RESP on `db:6379`; no `valkey` service or volume is generated,
and both the server and Kong are pointed at `db`. The port is exposed to the
compose network only — RESP on a public interface is an unauthenticated read of
every cached response.

To keep the Valkey sidecar instead:

```ts
cache: { provider: "valkey" },
```

Nothing about the cache's behaviour changes with the answer: both speak RESP
and both hold the same keys. What changes is how many stateful services the
stack runs, and where the memory comes from.

**`database.external` gets Valkey, and cannot get anything else.** pg_keyspace
is loaded through `shared_preload_libraries`, which is a property of a Postgres
this stack starts — against a database Supatype does not manage there is
nothing to configure. The default resolves to Valkey there on its own; asking
for `pg_keyspace` explicitly is refused rather than quietly downgraded, because
a stack that runs the thing you switched away from is worse than one that will
not start.

**A pinned `versions.postgres` keeps Valkey.** The keyspace is served by the
image, and the entrypoint honours `SUPATYPE_KEYSPACE_ENABLED` only from the
release that introduced it. An older image ignores the variable and starts with
no RESP listener — which is not an error anywhere: the stack comes up, the cache
never hits, and with TLS on Kong cannot store its certificate. A pin says this
project's image is fixed, and the default does not assume something about a
fixed image it cannot check.

So an unpinned project (tracking latest) gets the keyspace, and a pinned one
keeps the sidecar until it says otherwise:

```ts
versions: { postgres: "17.2.9" },
cache: { provider: "pg_keyspace" },
```

### What survives a restart, and what does not

**The keyspace is a cache.** Everything in it lives in shared memory and is
gone when the database restarts — which is the point: a response cache that
went through the WAL would put this stack's busiest write on disk to keep a
copy of something that expires in seconds.

**Kong's certificates are the exception, and they are kept for you.** They are
stored under `kong_acme:`, which the generated stack always names as durable —
whether or not TLS is on today, so enabling it later needs no database restart.
You do not have to configure this, and it is not a guess about someone else's
internals: Kong's ACME plugin enforces that prefix itself, and the arrangement
was verified on a live instance, where the certificates survived `kill -9` and
a cached response beside them did not.

If you store something of your own in the keyspace that must outlive a
restart, name its prefix:

```ts
cache: {
  provider: "pg_keyspace",
  durablePrefixes: ["session:"],
},
```

Each durable write goes through the WAL, which is the cost being avoided
everywhere else — so this list should stay short. See
`pg_keyspace.durability_overrides` in the
[pg_keyspace README](https://github.com/supatype/postgres/tree/develop/extensions/pg_keyspace).

### Memory

The keyspace reserves shared memory at postmaster start whether or not it is
used. The generated configuration sizes it for a self-hosted stack — 200,000
keys, a 16 MiB ring and a 64 MiB row cache, about **235 MiB** measured — rather
than the extension's own defaults, which reserve roughly 689 MiB before rings
and row cache. Budget for it alongside `shared_buffers` on a small host.

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
