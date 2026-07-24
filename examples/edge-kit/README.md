# Edge Kit — functions kitchen sink

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

From the monorepo root:

```bash
pnpm install
cd examples/edge-kit
cp .env.example .env
cp functions/.env.local.example functions/.env.local
pnpm keys
pnpm push
```

Ensure `.env` has `VITE_SUPATYPE_URL` and `VITE_SUPATYPE_ANON_KEY` (keys / dev write these). Open the **gateway** (`http://localhost:18473`), not Vite’s `:5173` alone, unless Vite’s proxy to Kong is active.

## Run

```bash
pnpm dev
```

`supatype dev` brings up Kong/Postgres/functions-worker and starts Vite (`app.mode=proxy`, `app.start=vite`). Open the gateway URL from the ready panel.

## Manual checklist (Deno types DX)

1. Open `functions/env-check/index.ts` — `Deno.env.get(...)` must **not** show `Cannot find name 'Deno'`.
2. Open `src/App.tsx` — must **not** see a global `Deno` namespace on app code (functions are excluded from the root tsconfig).
3. `pnpm typecheck` — both app and `functions/` projects pass.
4. With the stack up: **ping**, **env-check**, **echo**, **auth 401 / anon reject / user OK**, **write-note**, **webhook** all behave as labeled on the buttons.

## Notes

- Worker `SUPATYPE_URL` is **`http://kong:8000`** in Compose (server-side calls). Public links use `SITE_URL` / `API_EXTERNAL_URL`.
- `WEBHOOK_SECRET` defaults to `edge-kit-dev-webhook-secret` in `functions/.env.local.example` (matches the UI signer).
- Generated types under `supatype/generated/` are placeholders until `pnpm push` regenerates them.
- Port: server `54420` in `supatype.config.ts` to avoid clashing with other examples.
