# Self-Host Migration (Compose-First)

Supatype now treats Docker Compose as the canonical self-host runtime.

## What Changed

- `supatype self-host compose ...` is the primary workflow.
- Legacy native/systemd subcommands under `supatype self-host` remain available temporarily with deprecation warnings.
- `supatype app add/remove` now updates `supatype.config.ts` (`app.mode`) instead of editing root `docker-compose.yml`.

## New Recommended Workflow

1. Configure app intent in `supatype.config.ts`:
   - `app.mode = "none" | "static" | "proxy"`
   - `app.upstream` when `mode = "proxy"`
2. Render runtime artifacts:
   - `supatype self-host compose render`
3. Start services:
   - `supatype self-host compose up`
4. Check status:
   - `supatype self-host compose status`
5. Tail logs:
   - `supatype self-host compose logs`

Generated self-host artifacts are stored under `.supatype/self-host/`.

## Legacy Command Deprecation

The following commands are deprecated and will be removed in a future release:

- `supatype self-host install-service`
- `supatype self-host serve`
- `supatype self-host reload`
- `supatype self-host status`
- `supatype self-host logs`
- `supatype self-host backup`

Use `supatype self-host compose ...` equivalents instead.
