# Self-Host Example (maintainer fixture)

> **End users:** follow [supatype.github.io/supatype/#self-host](https://supatype.github.io/supatype/#self-host) in your own project — this directory is a maintainer fixture only.

This example shows the compose-first self-host flow for Supatype.

## What this includes

- `package.json` with local `@supatype/cli` dependency and helper scripts
- `supatype.config.ts` with `app.mode = "proxy"`
- `schema/index.ts` with a minimal `Todo` model
- `.env.example` for local self-host values

## Quick start

1. Copy env template:

```bash
cp .env.example .env
```

Supatype image overrides in `.env` let you pin beta tags:

- `SUPATYPE_POSTGRES_IMAGE`
- `SUPATYPE_SERVER_IMAGE`
- `SUPATYPE_STORAGE_IMAGE`
- `SUPATYPE_FUNCTIONS_WORKER_IMAGE`
- `SUPATYPE_CONTROL_PLANE_IMAGE`
- `SUPATYPE_STUDIO_IMAGE`
- `SUPATYPE_ENGINE_IMAGE` (schema-engine; compose `tools` profile)

If unset, compose defaults are used.

2. Install dependencies (from repo root):

```bash
pnpm install
```

3. From this example directory, render and start self-host compose:

```bash
pnpm run selfhost:render
pnpm run selfhost:up
```

4. Wait until services are healthy:

```bash
supatype self-host compose status
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

## Where is Studio?

Studio is available at:

- Direct: `http://localhost:3002`
- Through gateway: `http://localhost:18473/studio/`

**Authentication (production self-host):** Studio requires an admin login. The browser never receives `service_role`; privileged API calls go through `supatype-server` at `/studio/proxy/*` after your JWT is verified.

1. Create an admin user (first push may prompt, or run explicitly):

```bash
supatype admin create-user --email admin@example.com --password 'your-secure-password'
```

2. Open `/studio/` and sign in with that account.

Configure allowed roles in `supatype.config.ts` via `admin.roles` (default: `admin`, `supatype_admin`). Do not expose `/studio/` on the public internet without TLS and authentication.

Local docker dev (`supatype dev` with compose) sets `STUDIO_OPEN_DEV=1` on the server for frictionless iteration only — production compose does not.

If Studio is not loading:

```bash
supatype self-host compose status
supatype self-host compose logs --service studio
supatype self-host compose logs --service kong
```

Equivalent script command:

```bash
pnpm run selfhost:logs -- --service studio
```

## Endpoints

- API gateway: `http://localhost:18473`
- Studio (direct): `http://localhost:3002`
- Studio (gateway): `http://localhost:18473/studio/`
- REST: `http://localhost:18473/rest/v1/`
- Auth: `http://localhost:18473/auth/v1/`
- Storage: `http://localhost:18473/storage/v1/`
- Realtime: `ws://localhost:18473/realtime/v1/`

## Going live with a custom domain (HTTPS)

To serve this stack on a real domain with automatic Let's Encrypt TLS:

```bash
supatype add domain demo.example.com --email you@example.com
supatype self-host compose up -d
```

This sets `server.mode = "standalone"` + `server.domain` + `server.tls` in `supatype.config.ts`, then re-renders compose so Kong publishes `:80`/`:443`, a Valkey service stores the certs, and the `acme` plugin issues a certificate on the first HTTPS request. Point the domain's DNS A record at the host and open ports 80 and 443 first.

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

This example already includes `public/index.html`. After switching config, re-render and restart:

```bash
pnpm run selfhost:render
pnpm run selfhost:down
pnpm run selfhost:up
```

Then open:

- `http://localhost:18473/`

