# Self-host production

Docker provider is the default scaffold and required for production self-host.

## Local dev (Docker)

```bash
supatype keys          # if keys not in .env
supatype dev           # Compose stack; Kong on :18473
supatype push          # apply schema
```

`supatype dev` renders compose, starts services, and may write `SUPATYPE_KONG_PORT` and `SUPATYPE_DEV_DB_PORT` to `.env`.

## Static frontend in compose

```bash
supatype app add --static ./public   # or configure app.mode in config
npm run build                        # write assets to static_dir
supatype self-host compose render
supatype self-host compose up -d
supatype self-host compose status
```

## Production compose workflow

```bash
supatype self-host compose render    # write docker-compose.yml
supatype self-host compose up -d     # start production stack
supatype self-host compose down      # stop
supatype self-host compose status    # health check
```

Configure domain and SSL in `supatype.config.ts` under `selfHost` when ready for HTTPS (Caddy + Let's Encrypt).

## Standalone mode (native TLS)

For native ACME TLS without Compose:

```bash
supatype init --mode standalone
```

Set `server.domain` in config. Uses host binaries, not Docker Compose.

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
