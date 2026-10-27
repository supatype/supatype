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
supatype keys --write  # only if init skipped the keys
supatype dev           # Compose stack + control-plane; Kong on :18473; applies the schema on every save
supatype status        # local services or linked target summary
```

`supatype dev` renders compose, starts services, and may write `SUPATYPE_KONG_PORT`, `SUPATYPE_DEV_DB_PORT`, and `.supatype/environment.json` to the project. It refuses a `JWT_SECRET` shorter than 32 characters before starting anything. It stops its stack when the process that started it exits; to keep a stack up with nothing attached, use `supatype self-host compose up -d`.

Use `--direct` on schema commands to bypass the control plane and invoke the local engine subprocess directly.

## Functions: `ctx.url` and `ctx.publicUrl`

Every function is handed two addresses. `ctx.url` is for calling the API from inside the function:
compose sets it to `http://kong:8000`, a name only the stack's own network resolves. `ctx.publicUrl`
is the project's public address, for links you give to people (an email, a redirect, a URL in a
response): compose sets it from `API_EXTERNAL_URL`, the same value the server is told is its own,
so set that in `.env` to your domain (`supatype dev` writes the gateway's localhost address). A
worker started without `SUPATYPE_PUBLIC_URL` falls back to `ctx.url` and logs one warning at start.

## Functions: direct database access (`ctx.dbUrl`)

Functions receive a raw Postgres connection URL as `ctx.dbUrl` only when the operator sets
`SUPATYPE_FUNCTIONS_DB_URL` in `.env`. It is **off by default**, and deliberately separate from
`DATABASE_URL`. When the URL names the stack's `db` service, the functions worker also joins the
`functions-db` network so it can reach Postgres.

It is not a request through the API: it connects as whatever role the URL names and **bypasses
row rules and field masking**. With the admin URL (`supatype_admin`, as in `DATABASE_URL`) every
function, each of them a public endpoint, can read and write every row and column. Use a
least-privilege role granted only what the functions need:

```sql
-- once, as the admin: psql "$DATABASE_URL"
CREATE ROLE functions_reader LOGIN PASSWORD 'a-long-random-password';
GRANT USAGE ON SCHEMA public TO functions_reader;
GRANT SELECT ON public.orders TO functions_reader;
```

```bash
# .env (host is the compose service, db)
SUPATYPE_FUNCTIONS_DB_URL=postgresql://functions_reader:a-long-random-password@db:5432/my-project
```

Apply it with `supatype self-host compose up -d` (it renders the file again and recreates what
changed), or restart `supatype dev`. In a function, check `ctx.dbUrl !== undefined` before connecting, and never
return or log it. Prefer `createClient` with the caller's token for anything a user asks for: that
path keeps the schema's rules.

## Static frontend in compose

```bash
supatype app add --static ./public   # or configure app.mode in config
npm run build                        # write assets to static_dir
supatype self-host compose up -d
supatype self-host compose status
supatype deploy                      # uploads to control-plane when linked
```

## Production compose workflow

```bash
supatype self-host compose up -d     # render docker-compose.yml and start the production stack
supatype self-host compose down      # stop
supatype self-host compose status    # health check
supatype self-host compose restart server   # recreate one service after a .env change
supatype self-host compose restart functions-worker   # load edited functions/
supatype self-host compose logs --service postgrest
```

Use `restart <service>` rather than a hand-typed `docker compose` command (Compose's own `restart`
keeps the old container, so a changed `.env` never reaches it). The generated
`.supatype/self-host/docker-compose.yml` names the project's folders by absolute path and names its
compose project (`name: supatype-<project.name>`), so a hand-run
`docker compose -f .supatype/self-host/docker-compose.yml --env-file .env ...` reaches the same
stack. Every `self-host compose` command renders it again, so a project that moved is picked up there.

**Images are the ones the CLI release was tested with, never `:latest`.** Studio, storage,
realtime, functions-worker and the control plane run at the CLI's own version; the engine, server
and Postgres run the releases pinned for that CLI. A newer CLI moves them: upgrade the CLI, then
`supatype update` (or `self-host compose up -d`) pulls the new tags. To run another image, set its
`SUPATYPE_*_IMAGE` in `.env` (for example `SUPATYPE_SERVER_IMAGE=supatype/server:v2.3.0`) or pin
`versions.engine`, `versions.server` or `versions.postgres` in config; both win over the release's
pins.

**`compose up` checks `JWT_SECRET`.** Shorter than 32 characters stops it with
`JWT_SECRET in .env is <n> characters, and the REST API needs at least 32.` (PostgREST 14 would
otherwise restart in a loop). Fix: `openssl rand -base64 48` into `.env` as `JWT_SECRET`, then
`supatype keys --write --force` (plain `--write` only fills blank keys).

**A stack keeps its mode.** Every command that renders the compose file (`push`, `diff`, `adopt`,
`update`, every `self-host compose` command) uses one rule: dev while `supatype dev` runs for the
project, otherwise the mode the running server is in, otherwise standalone. So `supatype push` on a
production stack leaves it standalone and leaves `.env` alone, and `self-host compose restart` on a
`supatype dev` stack keeps it dev. "`supatype dev` runs" means `.supatype/dev-session.json` names a
live process: a file left by a killed `dev` (or written by a CLI older than this rule, which kept no
process ID) is removed and does not count.

**REST answers 503 until the first push.** A fresh stack returns `503` with `PGRST002` on every
`/rest/v1/` request: PostgREST will not serve until the schemas it exposes exist, and `supatype
push` creates them. This is expected, not a fault; run `supatype push` after `compose up -d`.
PostgREST then notices on its next retry, which can be up to about 30 s later, so `push` against
the compose stack waits (at most 40 s) until REST stops answering 503, printing one line while it
waits and saying so if it gives up. `supatype dev` is unaffected: it pushes before PostgREST starts.

## Allowed browser origins (CORS)

Outside dev mode the gateway answers CORS for every service behind it, with one rule:

- **Default:** the origin of `SITE_URL`, then `api.corsOrigins` from `supatype.config.ts`, then
  `SUPATYPE_CORS_ALLOW_ORIGINS` in `.env`.
- **Saved in Studio:** the Settings page's CORS tab. Owners, admins and developers can add and
  remove origins there. The list is stored in the project's database (`auth.cors_origins`), so it
  survives a restart, and every replica reads it within ten seconds. It replaces the default until
  someone presses Reset. The site URL stays allowed whatever is saved.
- **Everything else is refused:** a preflight from another origin gets `403`, and other responses
  carry no CORS headers.
- **`*`** allows every origin, and only when someone writes it in one of those places.

Dev mode reflects every origin, whatever the list says.

```ts
api: { corsOrigins: ["https://admin.example.com", "http://localhost:5173"] },
```

Entries must be `scheme://host[:port]` (http or https) or `*`; anything else stops the config
loading with `api.corsOrigins must be an array of origins (scheme://host[:port]) or "*"`. Before
this, a standalone server with no `SUPATYPE_CORS_ALLOW_ORIGINS` allowed every origin, so add any
production web app's origin before upgrading. On Cloud, `api.corsOrigins` is not deployed: the
project's own URL and Cloud Studio are always allowed, and owners, admins and developers edit
the rest in Studio's CORS tab.

## Studio roles

Studio signs in with email and password or with any of the project's enabled OAuth providers
(`auth.providers`; narrow the list with `studio.auth.providers`, see
[config](config.md#studio-sign-in-with-the-projects-providers)). However somebody signs in, Studio
lets them in only with a Studio role: a provider sign-in with no role shows "Access denied", and
no role is granted automatically. Provider sign-ins link to an existing user by verified email, so
only enable a provider whose "email verified" you trust (a self-run Keycloak realm included).

Studio members are separate from the app's users. One role set serves self-host and Cloud:
`owner`, `admin`, `developer`, `editor`, `billing`, `viewer`. Self-host grants `admin`,
`developer`, `editor` and `viewer` (a row naming `owner` or `billing` grants nothing there):

```bash
supatype admin create-user --email dev@example.com --role developer
supatype admin set-role --email dev@example.com --role viewer
supatype admin list-users
```

| Role | May |
|---|---|
| `admin` | everything: members, auth users, keys, domains, CORS list, elevated access |
| `developer` | everything an admin may do except grant Studio roles |
| `editor` | read and write rows; Data Explorer works, schema screens do not |
| `viewer` | read rows, schema screens and logs; changes nothing |

- **SQL editor** (and creating or dropping tables, views, functions, triggers, types, policies,
  extensions, RLS switches): owner, admin, developer. It signs in as `supatype_sql_editor`, a
  non-superuser member of the database owner, so RLS does not apply; every query is recorded.
- **Acting mode:** admins and developers (and owners on Cloud) act **elevated** (service role, no
  RLS) by default, and every such request is recorded. Editors and viewers act in **Studio mode**:
  the app's row rules are skipped, and field rules still apply, so masked columns stay masked. To
  see what the app's own rules allow, send a request built in Studio (API "Try it", GraphQL, a
  function's Invoke) as yourself. Asking for elevated access without the permission gets `403`.
- Viewers read the Database screens, policies, migration and seed history through a read-only
  metadata catalogue, not the SQL editor. Sessions on the Users screen are listed and revoked
  through the auth admin API (`/admin/sessions`).
- **Cloud:** the org role applies to every project in the org; a project's Studio membership row
  can only narrow it, and owners are never narrowed. The old org role `member` is now `developer`.
  To act as themselves a member links a project user by signing in to it once (same email as their
  Supatype account); until then self-mode requests answer `identity_link_required`.

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

Then bring the stack up. Compose and Kong are re-rendered from config on every run:

```bash
supatype self-host compose up -d
```

When `mode = "standalone"` + `domain` + `tls.email` are all set, the generated stack:

- publishes **Kong on `:80` and `:443`** (instead of the local `:18473`),
- adds the RESP cert store the `acme` plugin needs, served by the **`db` container itself** by default, or a **Valkey** service (persisted in the `valkey-data` volume) when `cache.provider` is `valkey` (see below),
- enables Kong's global **`acme`** plugin, which provisions a Let's Encrypt certificate on the first HTTPS request and auto-renews it.

Prerequisites: point the domain's DNS **A record** at the server's public IP and open ports **80** and **443** (HTTP-01 challenge needs `:80`). Your app, REST, Auth, Storage, Realtime, Functions and Studio are then all served behind `https://<domain>`.

Set `server.tls.provider = "none"` to keep a domain configured but stay on plain HTTP.

> A `supatype.local.config.ts` override with `server: { mode: "dev" }` keeps local `supatype dev` on HTTP. That file is gitignored, so HTTPS still activates on the production server where it does not exist.

## Cache provider: pg_keyspace or Valkey

The REST response cache and Kong's ACME certificates both speak RESP, so the
stack needs one RESP server. **By default that is `pg_keyspace`, inside the
Postgres container**: one stateful service instead of two, one image to keep
patched instead of two, and a cache whose memory is accounted for in the
database's own reservation.

The `db` service is started with the keyspace turned on
(`SUPATYPE_KEYSPACE_ENABLED=1`, which the image reads before any server
starts), serving RESP on `db:6379`; no `valkey` service or volume is generated,
and both the server and Kong are pointed at `db`. The port is exposed to the
compose network only, because RESP on a public interface is an unauthenticated read of
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
this stack starts. Against a database Supatype does not manage there is
nothing to configure. The default resolves to Valkey there on its own; asking
for `pg_keyspace` explicitly is refused rather than quietly downgraded, because
a stack that runs the thing you switched away from is worse than one that will
not start.

**The default follows the Postgres image that runs.** The keyspace is served by
the image, and the entrypoint honours `SUPATYPE_KEYSPACE_ENABLED` only from
17.2.9. An older image ignores the variable and starts with no RESP listener,
and that is not an error anywhere: the stack comes up, the cache never hits,
and with TLS on Kong cannot store its certificate. So the image decides:

| `versions.postgres` / `database.image` | Image run | Default cache |
|---|---|---|
| unset | the release this CLI pins | pg_keyspace |
| `"17"`, `"17.2"`, `"17-latest"` | `supatype/postgres:17-latest` | pg_keyspace |
| `"17.2.9"` or later, published | that exact tag | pg_keyspace |
| `"17.2.8"` or earlier, published | that exact tag | Valkey |
| an exact version that is not published | `17-latest`, with a warning | pg_keyspace |
| `database.image` other than a `supatype/postgres` tag | that image | Valkey |

An explicit `cache.provider` always wins. On the native provider a
`versions.postgres` pin does not decide the cache: native dev uses pg_keyspace
when the downloaded Postgres archive carries the library and its RESP port
answers, and falls back to the Valkey sidecar when either does not.
`database.external` is Valkey there too.

### What survives a restart, and what does not

**The keyspace is a cache.** Everything in it lives in shared memory and is
gone when the database restarts. That is the point: a response cache that
went through the WAL would put this stack's busiest write on disk to keep a
copy of something that expires in seconds.

**Kong's certificates are the exception, and they are kept for you.** They are
stored under `kong_acme:`, which the generated stack always names as durable,
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
everywhere else, so this list should stay short. See
`pg_keyspace.durability_overrides` in the
[pg_keyspace README](https://github.com/supatype/postgres/tree/develop/extensions/pg_keyspace).

### Memory

The keyspace reserves shared memory at postmaster start whether or not it is
used. The generated configuration sizes it for a self-hosted stack (200,000
keys, a 16 MiB ring and a 64 MiB row cache, about **235 MiB** measured) rather
than the extension's own defaults, which reserve roughly 689 MiB before rings
and row cache. Budget for it alongside `shared_buffers` on a small host.

`cache.provider = "pg_keyspace"` is rejected with `database.external`: it is
loaded through `shared_preload_libraries`, which is not something Supatype can
set on a Postgres it does not start.

## Standalone mode

`server.mode = "standalone"` is what `supatype init` writes when you choose a self-hosted
production target (`--mode standalone` does the same for older scripts). The scaffold uses the
Docker provider, and the stack runs under `supatype self-host compose`, where Kong serves TLS.
Running a standalone server natively, from host binaries, is not a supported self-host route in
0.7.0.

## Package.json scripts (typical)

```json
{
  "scripts": {
    "dev": "supatype dev",
    "push": "supatype push",
    "selfhost:up": "supatype self-host compose up -d",
    "selfhost:down": "supatype self-host compose down",
    "selfhost:status": "supatype self-host compose status"
  }
}
```
