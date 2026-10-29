---
title: "Functions"
description: "Write TypeScript functions that run on Deno at /functions/v1, read the caller's token, keep secrets in env files and self-host on the functions worker."
---

A function is a TypeScript file in `functions/` that runs on Deno and answers HTTP at `/functions/v1/<name>`. It receives a standard `Request` and returns a standard `Response`.

<h2 id="files">Where functions live</h2>

Functions sit in `functions/` at the project root. Each one is either a folder with an `index.ts` or a single `.ts` file. The name becomes the route.

| File | Route |
| --- | --- |
| `functions/send-invite/index.ts` | `/functions/v1/send-invite` |
| `functions/ping.ts` | `/functions/v1/ping` |
| `functions/_shared/email.ts` | none: shared code |

- Names starting with `_` or `.` are skipped, so `functions/_shared/` holds code every function can import with a relative path.
- `.d.ts` files are skipped.
- `_logs` is reserved by the worker, and the gateway refuses `/functions/v1/hooks` from outside, so do not use either name.

To use another directory, set `functions.path` in `supatype.config.ts`. It resolves against the project root.

```ts title="supatype.config.ts"
import { defineConfig } from "@supatype/cli"

export default defineConfig({
  // ...
  functions: {
    path: "functions",
  },
})
```

<h2 id="runtime">Runtime</h2>

Functions run on Deno. Locally the CLI downloads Deno on first use. On a self-hosted stack they run in the `functions-worker` container, and `supatype-server` proxies `/functions/v1` to it.

The worker loads every function once at startup and serves them from one process. Invocations run concurrently: nothing per call is written to the process environment, so one slow function does not block another.

The CLI writes three files to help your editor: `functions/deno.d.ts`, `functions/tsconfig.json` and `functions/_shared/context.ts`. It also adds `functions` to the root `tsconfig.json` `exclude` list, so your app's type check skips Deno code. `context.ts` is rewritten by `init`, `functions new`, `push` and `dev`, so do not edit it.

<h2 id="write">Write a function</h2>

Scaffold one with the CLI:

```sh
$ npx supatype functions new greet
```

A function default-exports a handler. It gets the request and a context object, and returns a `Response`. There is no Supatype package to import at runtime and no client injected for you.

```ts title="functions/greet/index.ts"
import type { FunctionContext } from "../_shared/context.ts"

export default async function handler(req: Request, ctx: FunctionContext): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ message: "Use POST" }, { status: 405 })
  }
  const { name } = (await req.json()) as { name?: string }
  return Response.json({ greeting: `Hello, ${name ?? "there"}`, region: ctx.region })
}
```

A thrown error becomes a `500` with `{ "error": "function_error", "message": "..." }`. An unknown name returns `404` with the list of available functions.

<h2 id="context">The context object</h2>

The second argument carries what the function needs about its call and its project.

| Field | What it holds |
| --- | --- |
| `executionId` | A UUID unique to this call. Every log line the call writes carries it. |
| `functionName` | The route being served. |
| `url` | The project's API base URL, reachable from inside the function. |
| `anonKey` | The project's anon key. |
| `serviceRoleKey` | Only present when the project grants this function the service role. See [Service role](#service-role). |
| `dbUrl` | A direct database URL, only when the deployment provides one. |
| `region` | `local` unless the deployment sets a region. |
| `env` | Your variables from the function env files. See [Environment and secrets](#env). |

<h2 id="auth">Who is calling</h2>

The client sends the signed-in user's access token in the `Authorization` header. The function receives that header as it was sent. Nothing checks it for you, so a function that cares who is calling must ask auth.

```ts title="functions/whoami/index.ts"
import type { FunctionContext } from "../_shared/context.ts"

export default async function handler(req: Request, ctx: FunctionContext): Promise<Response> {
  const authorization = req.headers.get("Authorization")
  if (!authorization) return Response.json({ message: "Sign in first" }, { status: 401 })

  const headers = { Authorization: authorization, apikey: ctx.anonKey }
  const res = await fetch(`${ctx.url}/auth/v1/user`, { headers })
  if (!res.ok) return Response.json({ message: "Not signed in" }, { status: 401 })

  const user = (await res.json()) as { id: string; email?: string }
  // Forward the same headers to REST and the user's access rules apply.
  const posts = await fetch(`${ctx.url}/rest/v1/post?select=title`, { headers })
  return Response.json({ id: user.id, posts: await posts.json() })
}
```

Forwarding the caller's token is the safe default: the database sees the user, not the function, and every [access rule](/docs/schema.html) still applies.

<h2 id="service-role">Service role</h2>

A function is a public endpoint. By default it does not receive the service-role key, which reads and writes past every access rule. The worker removes the key from the environment before any function is imported, so `Deno.env` cannot reach it either.

To give a function the key, name it in `functions.serviceRole`. It then appears as `ctx.serviceRoleKey`.

```ts title="supatype.config.ts"
export default defineConfig({
  // ...
  functions: {
    serviceRole: ["send-invite"],
  },
})
```

`supatype push` refuses a name that matches no function, so a typo cannot silently grant nothing. `supatype doctor` lists the current grants.

:::note[Local dev]
The local router does not apply this list. Under `supatype dev` every function receives `ctx.serviceRoleKey`, and under `supatype functions serve` every function does when `SUPATYPE_SERVICE_ROLE_KEY` is set in your shell. Test that a function works without the key on a self-hosted stack.
:::

<h2 id="env">Environment and secrets</h2>

Variables for functions live in env files inside the functions directory:

- `functions/.env.local` is shared by every function.
- `functions/.env.<name>.local` applies to one function and overrides the shared file.

Read them from `ctx.env`. The files are read on each call, so a changed value takes effect without a restart. Keep them out of git.

```sh
$ npx supatype functions env set RESEND_API_KEY=re_123
$ npx supatype functions env list
$ npx supatype functions env unset RESEND_API_KEY
```

On a project that is not linked, these commands edit `functions/.env.local`. `list` masks the values.

```ts title="functions/send-invite/index.ts"
const apiKey = ctx.env["RESEND_API_KEY"]
if (!apiKey) return Response.json({ message: "RESEND_API_KEY is not set" }, { status: 500 })
```

<h2 id="call">Call a function</h2>

From your app, use `functions.invoke` on the client. It posts JSON to `/functions/v1/<name>` with the user's token and returns `{ data, error }`. A non-2xx response becomes `error`, using the `message` field from the body when there is one.

``` title="typescript"
const { data, error } = await supatype.functions.invoke("greet", { body: { name: "Alex" } })
```

`invoke` also takes `method` (default `POST`) and `headers`. A JSON response is parsed and anything else comes back as text. On a `401` the client refreshes the session once and retries. More in [Client: Functions](/docs/client.html#functions).

<h2 id="local">Local development</h2>

`supatype dev` serves functions through the same gateway as the rest of the API when a functions directory exists. You do not run anything else.

To run functions on their own, with Deno watching for changes:

```sh
$ npx supatype functions serve
$ npx supatype functions invoke greet --local --data '{"name":"Alex"}'
```

`serve` listens on port `54321` by default; change it with `--port`. It loads `functions/.env.local` unless you pass `--env-file`. `invoke` sends a POST, prints the status and the response, and gives up after 30 seconds. `--auth` adds a test token to the request.

<h2 id="self-host">Self-host</h2>

The self-host Compose file always includes a `functions-worker` service, built from the `supatype/functions-worker` image. It mounts the project read-only and serves `functions/` from it. There is no bundle or upload step: the files on disk are what runs.

The worker reads code once at startup, so restart it after changing a function:

```sh
$ docker compose -p supatype-<project> -f .supatype/self-host/docker-compose.yml restart functions-worker
```

`<project>` is your project name from `supatype.config.ts` in lower case, with spaces and other symbols replaced by `-`. Env file changes do not need a restart.

The worker gets the anon and service-role keys from the stack. To give functions a database connection, set `SUPATYPE_FUNCTIONS_DB_URL`; it appears as `ctx.dbUrl`. It is off by default because a direct connection bypasses access rules, field masking and model hooks. Point it at a role you have restricted, or accept that.

Function logs are JSON lines on the container's output, each with the call's `request_id`, status and duration:

```sh
$ npx supatype self-host compose logs --service functions-worker
```

:::note
The Compose file mounts `functions/` at the project root. Keep the default path on a self-hosted stack.
:::

<h2 id="hooks">Model hooks</h2>

A model hook is a handler the API server calls around a write to one model: to check it, change it, refuse it, or react once it has happened. Hooks run on the same Deno worker as functions, but they are not public endpoints. They live in their own `hooks/` directory at the project root, the worker serves them under a `hooks/` route, and the gateway refuses that route from outside.

### Triggers

| Key | Runs | Can |
| --- | --- | --- |
| `beforeChange` | Before an insert or update reaches Postgres | Let it through, replace the rows or the patch, or refuse it |
| `afterChange` | After an insert or update succeeded | React only. It cannot change or undo the write |
| `beforeDelete` | Before a delete reaches Postgres | Let it through or refuse it |
| `afterDelete` | After a delete succeeded | React only |

Hooks fire on writes to `/rest/v1/<table>`: `POST` and `PUT` are inserts, `PATCH` is an update, `DELETE` is a delete. That covers the client's `insert`, `upsert`, `update` and `delete`, including calls made with the service-role key. RPC calls, direct SQL, seeds and migrations do not fire them.

### Declare a hook

Name the handler in the model's second argument. A string is the handler's directory name; an object adds options.

```ts title="schema/index.ts"
export type Post = Model<{
  id: UUID
  title: string
  // ...
}, {
  // access, versions, ...
  hooks: {
    beforeChange: "check-post"
    afterChange: { function: "notify-post"; timeout: 5000 }
  }
}>
```

| Option | Meaning |
| --- | --- |
| `function` | The directory under `hooks/`. |
| `timeout` | Milliseconds to wait for an answer. Default `2000`. |
| `onUnavailable` | What to do when the hook does not answer: a timeout, a connection failure, a `5xx`, a thrown error or an unreadable body. `"reject"` refuses the write, `"log"` lets it through and logs. Defaults to `"reject"` for `before*` hooks and `"log"` for `after*` hooks. |

`supatype push` refuses a schema whose hook names a directory with no `index.ts`, so a typo cannot leave a hook that never fires.

### Write the handler

```sh
$ npx supatype hooks new check-post
$ npx supatype hooks list
```

`hooks new` creates `hooks/<name>/index.ts`. When a model already names it, the file is set up for that event; otherwise the command prints the line to add to the model. `hooks list` prints each `Model.event` with its handler and marks any whose handler is missing. `supatype doctor` reports the same.

Handlers import their types from `hooks/_supatype/hooks.ts`, which `push`, `dev` and `generate` write from your schema. Until the first push it does not exist, so a new handler will not compile yet. Do not edit it.

```ts title="hooks/check-post/index.ts"
import { hook, type BeforeChange } from "../_supatype/hooks.ts"

const checkPost: BeforeChange<"post"> = async (ctx) => {
  if (ctx.operation === "insert") {
    if (ctx.rows.some((row) => row.title.trim() === "")) return { reject: "A post needs a title" }
    return { rows: ctx.rows.map((row) => ({ ...row, title: row.title.trim() })) }
  }
  if (ctx.patch.title !== undefined && ctx.patch.title.trim() === "") {
    return { reject: { message: "A post needs a title", status: 422, code: "empty_title" } }
  }
  return {}
}

export default hook(checkPost)
```

The type argument is the table name. `BeforeChange`, `AfterChange`, `BeforeDelete` and `AfterDelete` type the context from the model, and only tables that declare a hook are accepted.

| Context field | What it holds |
| --- | --- |
| `table`, `operation` | The table and `insert`, `update` or `delete`. |
| `user` | `sub`, `role` and `email` from the caller's verified token, or `null` for an anonymous caller. |
| `requestId` | Matches the request in the server logs. |
| `rows` | An insert's rows, always an array. On `afterChange`, the written rows, only when the caller asked for them back with `.select()`. |
| `patch` | An update's changes. |
| `filter` | The request's filter on an update or delete, such as `id=eq.42`. A hook cannot change it. |
| `previous()` | Before an update or delete: fetches the rows about to change, up to 100, with `truncated: true` when there were more. They come back as stored, without field masking, so do not copy them into a refusal message. |

A `before*` handler returns `{}` to let the write through. `beforeChange` can return `{ rows }` for an insert or `{ patch }` for an update to replace what is written. `{ reject }` refuses the write: the caller gets your message with status `422`, or the `4xx` status you set. A thrown error is not a refusal: it counts as the hook not answering, and `onUnavailable` decides.

To keep a model's whole lifecycle in one directory, point several events at the same name and export `hooks({ beforeChange: checkPost, afterChange: notify })` instead of `hook(...)`. An event with no handler in that map lets the write through.

### How hooks run

- The server reads the whole request body before any hook runs. A body over 1 MiB on a write to a hooked table is refused, rather than written without the hook.
- An `after*` hook runs once the caller already has its response. Its failures are logged and never reach the caller.
- A hook may write through the API, and those writes fire hooks too. A chain more than four hooks deep is refused with status `508`, so a hook that writes to its own table cannot loop forever.
- On a Docker stack the `functions-worker` container mounts `hooks/` next to `functions/`. When `supatype dev` runs on Docker, the worker restarts when a hook file changes. On a self-hosted stack, restart it after changing a hook, as for functions.

:::note[Not a security boundary]
Direct SQL, seeds and migrations skip hooks. A rule every writer must follow belongs in the model's [access rules](/docs/schema.html#access) or a constraint. Use hooks for application logic: enrichment, notifications, indexing, and checks the database cannot express.
:::

<h2 id="limits">Limits</h2>

- The gateway waits up to two minutes for a function to start responding.
- The self-host worker sets no memory or CPU cap per function. Set container limits in Compose if you need them.
- Function names and bodies are not typed on the client.
