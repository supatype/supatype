# Edge Kit: functions kitchen sink

Maintainer / contributor example for **edge functions**: Deno IDE types, env injection, auth gates, PostgREST writes from Deno, and webhook HMAC.

## What you get

| Function | Exercises |
|---|---|
| `ping` | Basic invoke |
| `env-check` | `Deno.env` + worker-injected Supatype keys |
| `echo` | JSON body round-trip |
| `auth-required` | Reject missing / anon Bearer; accept user JWT |
| `write-note` | Service-role `fetch` → `/rest/v1/note` (via in-compose Kong) |
| `webhook` | `_shared` HMAC verify (`x-webhook-signature`) |

Also:

- `functions/deno.d.ts` + `functions/tsconfig.json` (no `Cannot find name 'Deno'` in the IDE)
- Root `tsconfig.json` **excludes** `functions/` so the Vite app stays Node/DOM-only
- Full-width dual-column Vite UI (`pnpm dev` starts Vite via `app.start`)

## Setup

Running this outside the repo? See [Running an example](../README.md#running-an-example).

From the monorepo root:

```bash
pnpm install
pnpm build             # the CLI and the libraries run from their dist/
cd examples/edge-kit
cp .env.example .env
cp functions/.env.local.example functions/.env.local
pnpm keys
```

Ensure `.env` has `VITE_SUPATYPE_URL` and `VITE_SUPATYPE_ANON_KEY` (keys / dev write these). Open the **gateway** (`http://localhost:18473`), not Vite’s `:5173` alone, unless Vite’s proxy to Kong is active.

## Run

```bash
pnpm dev
```

`supatype dev` brings up Kong/Postgres/functions-worker, pushes the schema, and starts Vite (`app.mode=proxy`, `app.start=vite`). Open the gateway URL from the ready panel.

There is no separate push step: `dev` pushes the schema when it starts and again on every save, and on its first start it writes the database passwords and the database port into `.env`. `pnpm push` works once `dev` has run; before that `.env` has no `AUTHENTICATOR_PASSWORD` or `SUPATYPE_SQL_EDITOR_PASSWORD` and the push refuses.

## Manual checklist (Deno types DX)

1. Open `functions/env-check/index.ts`: `Deno.env.get(...)` must **not** show `Cannot find name 'Deno'`.
2. Open `src/App.tsx`: must **not** see a global `Deno` namespace on app code (functions are excluded from the root tsconfig).
3. `pnpm typecheck`: both app and `functions/` projects pass.
4. With the stack up: **ping**, **env-check**, **echo**, **auth 401 / anon reject / user OK**, **write-note**, **webhook** all behave as labeled on the buttons.

Step 4 is automated: `bash tests/integration/scripts/edge-kit-e2e.sh` (from the monorepo root) starts the stack and calls every function through the gateway, anonymous and signed in, including the service-role gate and a forged webhook signature.

## Notes

- Worker `SUPATYPE_URL` is **`http://kong:8000`** in Compose (server-side calls). Public links use `SITE_URL` / `API_EXTERNAL_URL`.
- `WEBHOOK_SECRET` defaults to `edge-kit-dev-webhook-secret` in `functions/.env.local.example` (matches the UI signer).
- Generated types under `supatype/generated/` are placeholders until `pnpm dev` (or `pnpm push`) regenerates them.
- Ports: the gateway is on `SUPATYPE_KONG_PORT` (default 18473) and Postgres on `SUPATYPE_DEV_DB_PORT` (default 54329, the port `DATABASE_URL` names). `dev` moves either to the next free port when it is taken, and writes the one it chose into `.env`.
