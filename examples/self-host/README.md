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
- `SUPATYPE_REALTIME_IMAGE`
- `SUPATYPE_STUDIO_IMAGE`
- `SUPATYPE_SCHEMA_ENGINE_IMAGE`

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

