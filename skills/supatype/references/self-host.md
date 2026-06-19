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
