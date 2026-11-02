# Supatype functions-worker

External Deno runtime for edge functions. **supatype-server** proxies `/functions/v1` here when `SUPATYPE_FUNCTIONS_WORKER_URL` is set (self-host Compose, managed cloud).

## Isolation modes

| `SUPATYPE_FUNCTION_NAME` | Behaviour |
|--------------------------|-----------|
| unset | **Per-project**, discover and serve all handlers under `SUPATYPE_FUNCTIONS_ROOT` |
| set | **Per-function**, load only that handler (shared pool / dedicated single-function workers) |

`supatype dev` on the Docker provider (the default) runs this image, as self-host Compose does. Only the native provider (`provider: "native"`) runs functions in a Deno subprocess started by the server instead.

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPATYPE_FUNCTIONS_ROOT` | yes | Directory of function sources (e.g. `/project/functions`) |
| `PORT` | no | Listen port (default `8001`) |
| `SUPATYPE_FUNCTION_NAME` | no | Single-function mode |
| `SUPATYPE_URL` | no | **In-compose:** `http://kong:8000` (Docker DNS). Do not inject the public/host gateway URL, `localhost` inside the container cannot reach Kong on the host. Use for server-side `fetch` / `createClient`. Handed to every function as `ctx.url`. |
| `SUPATYPE_INTERNAL_URL` | no | Same as `SUPATYPE_URL` in Compose (`http://kong:8000`) |
| `SUPATYPE_PUBLIC_URL` | no | The project's public address, the gateway URL a browser or an app uses. Handed to every function as `ctx.publicUrl`, for links you give to people. Compose sets it from `API_EXTERNAL_URL`, the address the server is told is its own. Unset, `ctx.publicUrl` falls back to `ctx.url` and the worker logs one warning at start |
| `SUPATYPE_ANON_KEY`, `SUPATYPE_SERVICE_ROLE_KEY` | no | Injected per invocation when set |
| `SITE_URL` | no | Public site URL for browser-facing links (not the same as `SUPATYPE_URL`) |
| `SUPATYPE_DB_URL` | no | Handed to every function as `ctx.dbUrl`. Off by default; Compose sets it from the project's `SUPATYPE_FUNCTIONS_DB_URL`. See [Direct database access](#direct-database-access-ctxdburl) |

Per-function env files: `{root}/.env.{name}.local`; shared: `{root}/.env.local`.

Tests: `deno task test` starts this worker as the image does and reads a function's context back over HTTP.

## Direct database access (`ctx.dbUrl`)

A function can be given a raw Postgres connection URL as `ctx.dbUrl`. It is **off by default**: the
field is undefined unless the operator sets `SUPATYPE_FUNCTIONS_DB_URL` in the project's `.env`.
Compose passes that value to this worker as `SUPATYPE_DB_URL`, and when the URL names the stack's
`db` service the worker also joins the `functions-db` network so it can reach Postgres. It is a
separate variable from the project's `DATABASE_URL` on purpose, so handing functions a database
connection is a decision rather than a default.

What it is not: a request through the API. It connects as whatever role the URL names, so it
**bypasses the schema's row rules and field masking**. With the admin URL
(`supatype_admin`, the one in `DATABASE_URL`) a function reads and writes every row and every
column of every table, whatever the schema says. Every function in the project receives it, and a
function is a public endpoint.

Use a least-privilege role granted only what the functions need, never the admin URL:

```sql
-- Run once as the admin, e.g. psql "$DATABASE_URL"
CREATE ROLE functions_reader LOGIN PASSWORD 'a-long-random-password';
GRANT USAGE ON SCHEMA public TO functions_reader;
GRANT SELECT ON public.orders TO functions_reader;
```

```bash
# .env (the host is the compose service name, `db`)
SUPATYPE_FUNCTIONS_DB_URL=postgresql://functions_reader:a-long-random-password@db:5432/my-project
```

Then run `supatype self-host compose up -d` (it renders the file again), or restart
`supatype dev`. In the function, treat the URL as a credential: never return it or log it.

```ts
import postgres from "npm:postgres@3.4.5"
import type { FunctionContext } from "../_shared/context.ts"

export default async function handler(_req: Request, ctx: FunctionContext): Promise<Response> {
  if (ctx.dbUrl === undefined) return new Response("No database URL configured", { status: 501 })
  const sql = postgres(ctx.dbUrl, { max: 1 })
  try {
    const [row] = await sql`select count(*)::int as orders from public.orders`
    return Response.json(row)
  } finally {
    await sql.end()
  }
}
```

## Build

```bash
docker build -t supatype/functions-worker:latest packages/functions-worker
```
