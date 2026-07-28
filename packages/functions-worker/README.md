# Supatype functions-worker

External Deno runtime for edge functions. **supatype-server** proxies `/functions/v1` here when `SUPATYPE_FUNCTIONS_WORKER_URL` is set (self-host Compose, managed cloud).

## Isolation modes

| `SUPATYPE_FUNCTION_NAME` | Behaviour |
|--------------------------|-----------|
| unset | **Per-project** — discover and serve all handlers under `SUPATYPE_FUNCTIONS_ROOT` |
| set | **Per-function** — load only that handler (shared pool / dedicated single-function workers) |

Local `supatype dev` does **not** use this image; the CLI starts an in-process Deno subprocess via the server **unless** Compose sets `SUPATYPE_FUNCTIONS_WORKER_URL` (Docker provider).

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPATYPE_FUNCTIONS_ROOT` | yes | Directory of function sources (e.g. `/project/functions`) |
| `PORT` | no | Listen port (default `8001`) |
| `SUPATYPE_FUNCTION_NAME` | no | Single-function mode |
| `SUPATYPE_URL` | no | **In-compose:** `http://kong:8000` (Docker DNS). Do not inject the public/host gateway URL — `localhost` inside the container cannot reach Kong on the host. Use for server-side `fetch` / `createClient`. |
| `SUPATYPE_INTERNAL_URL` | no | Same as `SUPATYPE_URL` in Compose (`http://kong:8000`) |
| `SUPATYPE_ANON_KEY`, `SUPATYPE_SERVICE_ROLE_KEY` | no | Injected per invocation when set |
| `SITE_URL` | no | Public site URL for browser-facing links (not the same as `SUPATYPE_URL`) |

Per-function env files: `{root}/.env.{name}.local`; shared: `{root}/.env.local`.

## Build

```bash
docker build -t supatype/functions-worker:latest packages/functions-worker
```
