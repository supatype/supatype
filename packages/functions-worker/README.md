# Supatype functions-worker

External Deno runtime for edge functions. **supatype-server** proxies `/functions/v1` here when `SUPATYPE_FUNCTIONS_WORKER_URL` is set (self-host Compose, managed cloud).

## Isolation modes

| `SUPATYPE_FUNCTION_NAME` | Behaviour |
|--------------------------|-----------|
| unset | **Per-project** — discover and serve all handlers under `SUPATYPE_FUNCTIONS_ROOT` |
| set | **Per-function** — load only that handler (shared pool / dedicated single-function workers) |

Local `supatype dev` does **not** use this image; the CLI starts an in-process Deno subprocess via the server.

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPATYPE_FUNCTIONS_ROOT` | yes | Directory of function sources (e.g. `/project/functions`) |
| `PORT` | no | Listen port (default `8001`) |
| `SUPATYPE_FUNCTION_NAME` | no | Single-function mode |
| `SUPATYPE_URL`, `SUPATYPE_ANON_KEY`, `SUPATYPE_SERVICE_ROLE_KEY` | no | Injected per invocation when set |

Per-function env files: `{root}/.env.{name}.local`; shared: `{root}/.env.local`.

## Build

```bash
docker build -t supatype/functions-worker:latest packages/functions-worker
```
