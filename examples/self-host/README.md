# Self-Host Example (maintainer fixture)

> **End users:** follow [supatype.com/docs/#self-host](https://www.supatype.com/docs/#self-host) in your own project, this directory is a maintainer fixture only.

This example shows the compose-first self-host flow for Supatype.

## What this includes

- `package.json` with local `@supatype/cli` dependency and helper scripts
- `supatype.config.ts` with `app.mode = "proxy"`
- `schema/index.ts` with a minimal `Todo` model
- `.env.example` for local self-host values

## Quick start

Running this outside the repo? See [Running an example](../README.md#running-an-example).

1. Copy env template:

```bash
cp .env.example .env
```

Set `POSTGRES_PASSWORD`, `AUTHENTICATOR_PASSWORD`, `SUPATYPE_SQL_EDITOR_PASSWORD`
and `JWT_SECRET` to values of your own. Make each password with `openssl rand -hex 24`: 0.7.0
does not encode these passwords when it puts them in connection URLs.

Leave `ANON_KEY` and `SERVICE_ROLE_KEY` blank: they are JWTs signed
with `JWT_SECRET`, so `selfhost:up` mints them on first start and leaves any
value you set alone. `SUPATYPE_CONTROL_PLANE_SECRET` is generated the same way:
only the API server and the control plane receive it, and the control plane
refuses any request that does not present it.

Supatype image overrides in `.env` let you pin beta tags:

- `SUPATYPE_POSTGRES_IMAGE`
- `SUPATYPE_SERVER_IMAGE`
- `SUPATYPE_STORAGE_IMAGE`
- `SUPATYPE_FUNCTIONS_WORKER_IMAGE`
- `SUPATYPE_CONTROL_PLANE_IMAGE`
- `SUPATYPE_STUDIO_IMAGE`
- `SUPATYPE_ENGINE_IMAGE` (schema-engine; compose `tools` profile)

If unset, compose defaults are used.

2. From the monorepo root:

```bash
pnpm install
pnpm build   # the CLI and the libraries run from their dist/
```

3. From this example directory, start self-host compose (it renders the compose file first):

```bash
pnpm run selfhost:up
```

4. Wait until services are healthy:

```bash
pnpm exec supatype self-host compose status
```

5. Push schema:

```bash
pnpm run push
```

6. Tail logs (optional):

```bash
pnpm run selfhost:status
pnpm run selfhost:logs
```

## Direct database access for functions

`SUPATYPE_FUNCTIONS_DB_URL` hands every function a raw Postgres URL as `ctx.dbUrl`. It is **off by
default** (commented out in `.env.example`), and separate from `DATABASE_URL` on purpose. When the
URL names the stack's `db` service, the functions worker joins the `functions-db` network to reach
it.

It is not a request through the API. It connects as whatever role the URL names and **bypasses row
rules and field masking**, and every function is a public endpoint, so do not use the admin URL
(`POSTGRES_USER`). Create a role granted only what the functions need:

```sql
-- once, as the admin
CREATE ROLE functions_reader LOGIN PASSWORD 'change-me';
GRANT USAGE ON SCHEMA public TO functions_reader;
GRANT SELECT ON public.todo TO functions_reader;
```

```bash
# .env
SUPATYPE_FUNCTIONS_DB_URL=postgresql://functions_reader:change-me@db:5432/self_host_example
```

Then `pnpm run selfhost:up`. In a function, check
`ctx.dbUrl !== undefined` before connecting, and never return or log the URL.

## Where is Studio?

Studio is at `http://localhost:18473/studio/`, through the gateway. The Studio container is not
published on a host port of its own.

**Authentication (production self-host):** Studio requires an admin login. The browser never receives `service_role`; privileged API calls go through `supatype-server` at `/studio/proxy/*` after your JWT is verified.

1. Create an admin user (first push may prompt, or run explicitly):

```bash
pnpm exec supatype admin create-user --email admin@example.com --password 'your-secure-password' --role admin
```

2. Open `/studio/` and sign in with that account.

Configure allowed roles in `supatype.config.ts` via `admin.roles` (default: `admin`, `supatype_admin`). Do not expose `/studio/` on the public internet without TLS and authentication.

Studio asks for this sign-in in local docker dev (`supatype dev`) too. There is no unauthenticated Studio mode: the server ignores `STUDIO_OPEN_DEV`, which older CLIs wrote into the dev compose file, and logs a warning when it is set.

If Studio is not loading:

```bash
pnpm exec supatype self-host compose status
pnpm exec supatype self-host compose logs --service studio
pnpm exec supatype self-host compose logs --service kong
```

Equivalent script command:

```bash
pnpm run selfhost:logs -- --service studio
```

## Endpoints

- API gateway: `http://localhost:18473`
- Studio: `http://localhost:18473/studio/`
- REST: `http://localhost:18473/rest/v1/`
- Auth: `http://localhost:18473/auth/v1/`
- Storage: `http://localhost:18473/storage/v1/`
- Realtime: `ws://localhost:18473/realtime/v1/`

## Going live with a custom domain (HTTPS)

To serve this stack on a real domain with automatic Let's Encrypt TLS:

```bash
pnpm exec supatype add domain demo.example.com --email you@example.com
pnpm exec supatype self-host compose up -d
```

This sets `server.mode = "standalone"` + `server.domain` + `server.tls` in `supatype.config.ts`. Kong then serves `:80` and `:443` and issues a Let's Encrypt certificate on the first HTTPS request (stored in Postgres in this example). Point the domain's DNS A record at the host and open ports 80 and 443 first.

## App routing

This example uses:

- `app.mode = "proxy"`
- `app.upstream = "http://host.docker.internal:3000"`

So requests to `/` are proxied to a local app server running on port `3000`.

You can switch to static mode:

```ts
app: {
  mode: "static",
  static_dir: "./public",
}
```

This example already includes `public/index.html`. After switching config, restart the stack:

```bash
pnpm run selfhost:down
pnpm run selfhost:up
```

Then open:

- `http://localhost:18473/`

