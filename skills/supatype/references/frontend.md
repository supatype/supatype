# Frontend integration

Reference layout: `supatype init` with a self-hosted production target, a static site and Vite. Maintainer fixture: **`examples/self-host/`** in the Supatype repo (compose-first, proxy mode).

## Add dependencies

```bash
npm install @supatype/client @supatype/cli @supatype/types
npm install -D vite @vitejs/plugin-react typescript  # Vite + React example
```

Install matching versions from npm:

```bash
npm view @supatype/cli dist-tags    # compare latest vs alpha
npm install @supatype/cli@latest @supatype/client@latest @supatype/types@latest
```

Use `@alpha` only when the alpha tag is newer than `latest`:

```bash
npm install @supatype/cli@alpha @supatype/client@alpha @supatype/types@alpha
```

Pin all `@supatype/*` packages to the **same version**. Use `file:` links only when developing the CLI itself.

## Self-host + local dev config split

Committed `supatype.config.ts` targets production. `supatype.local.config.ts` (gitignored) is
deep-merged over it for local development only: `supatype dev` reads it, and the self-host
commands, `deploy` and a push to a production stack leave it out (see
[self-host.md](self-host.md#local-overrides-stay-local)). This is what init writes for a self-host
target with a static Vite app:

```typescript
// supatype.config.ts (committed)
import { defineConfig } from "@supatype/cli"

export default defineConfig({
  project: { name: "my-app" },
  provider: "docker",
  database: { provider: "docker" },
  server: {
    mode: "standalone",
    domain: "demo.supatype.com",
    tls: { email: "you@example.com" },
  },
  app: {
    mode: "static",
    static_dir: "./dist",  // production build output
  },
  environments: { default: "production" },
  email: { provider: "console" },
  storage: { provider: "local", local_path: ".supatype/storage" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
  output: { types: "types/database.ts", client: "supatype/generated/index.d.ts" },
})
```

```typescript
// supatype.local.config.ts (gitignored)
import type { SupatypeConfig } from "@supatype/cli"

const localConfig: Partial<SupatypeConfig> = {
  server: { mode: "dev" },
  app: {
    mode: "proxy",
    upstream: "http://127.0.0.1:5173",
    start: "vite",
    vite_dev_url: "http://127.0.0.1:5173",
  },
}

export default localConfig
```

A docker project's config has no `server.port`: its API is on the gateway port in `.env`
(`SUPATYPE_KONG_PORT`). Only `provider: "native"` writes `server.port: 18471`.

**Do not pin `versions` for Docker** unless you need a specific release. Omit the block to run the
images the installed CLI release was tested with.

`supatype dev` regenerates the types (`types/database.ts`) and the client
(`supatype/generated/client.ts`) on every schema save; `supatype generate` does it once, offline.

## Frontend env files

The CLI writes the front end's API address and anon key under every framework's public prefix:
`VITE_SUPATYPE_URL` and `VITE_SUPATYPE_ANON_KEY`, plus `PUBLIC_`, `NEXT_PUBLIC_` and `EXPO_PUBLIC_`
copies. Where they go depends on whose values they are:

| Values | File | Read by |
|--------|------|---------|
| The local stack's (`http://localhost:<port>` and its anon key) | `.env.development.local` (gitignored) | Vite, Next.js and Expo in development only |
| A real deployment's (`supatype keys` where `API_EXTERNAL_URL` is the server's real address) | `.env` | every build, production included |

`supatype init` (docker), `supatype dev` and `supatype keys` all follow this. Writing a local
stack's values also removes the CLI's old localhost copies from `.env` and `.env.local`, and says
so, so a production build no longer ships `localhost` or the dev anon key. `ANON_KEY` and
`SERVICE_ROLE_KEY` themselves stay in `.env`. A production build on a CI host (Vercel, Netlify,
Cloudflare Pages, GitHub Actions) reads none of these files: see
[Production builds](#production-builds).

Pass both names straight to `createClient`. For a value the build did not carry, the client reads
the page's `window.__SUPATYPE_ENV__` (set by `<script src="/supatype-env.js" vite-ignore>` when Supatype serves
the app, or by the Next.js route below), at its first request. It never guesses the address from
the page's origin. `createClient` itself never throws, so `next build` can prerender a page that
creates one at module scope; the first request made with no address or no anon key throws
`MissingClientValuesError` (`Supatype client has no anon key. createClient was given none, and the
page had set no window.__SUPATYPE_ENV__ by its first request. ...`), naming the variables,
`supatype build`, the script tag and the Next.js route. REST, rpc, auth, storage, functions, GraphQL
and realtime all throw it rather than returning `{ data: null, error }`. Do not add an
`if (!key) throw` of your own: a bundler that knows the name is unset can fold it into a throw that
hides the cause, and an `?? window.location.origin` on the URL stops the page's value from ever
being read.

```typescript
// The generated client, not "@supatype/client": it registers which models keep drafts.
import { createClient } from "../supatype/generated/client"

export const supatype = createClient({
  url: import.meta.env.VITE_SUPATYPE_URL,
  anonKey: import.meta.env.VITE_SUPATYPE_ANON_KEY,
})
```

Call `createClient` with no type argument: the generated client already carries the schema's types.
`createClient<Database>` loses the drafts typing (`update(..., { publish: true })` stops compiling)
and makes every `rpc(...)` name `never`.

## Vite config

What init writes (`build.outDir` only when the static directory is not `./dist`):

```typescript
// vite.config.ts
import { defineConfig } from "vite"

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Docker Compose app proxy reaches the host as host.docker.internal.
    allowedHosts: ["127.0.0.1", "localhost", "host.docker.internal"],
  },
})
```

Add `plugins: [react()]` (from `@vitejs/plugin-react`) for a React app.

## package.json scripts

From `supatype init` (a new `package.json`; a merge into an existing one adds the missing scripts,
puts `supatype dev` under `supatype:dev` when your own `dev` script is something else, and chains
`supatype generate` onto a `prepare` of your own):

```json
{
  "name": "my-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "supatype dev",
    "push": "supatype push",
    "seed": "supatype seed",
    "prepare": "supatype generate",
    "vite": "vite",
    "build": "vite build"
  }
}
```

`vite` and `build` are there only when init set up Vite, and `functions`
(`supatype functions serve`) only with the hello-world function. `prepare` runs on every install and
writes the gitignored seed builder (`supatype/generated/seed.ts`), so `npm run seed` works in a
fresh clone.

## Local dev workflow (Vite)

**Production** (`supatype.config.ts`): `app.mode: "static"`, `static_dir: "./dist"`.

**Local** (`supatype.local.config.ts`): `app.mode: "proxy"` with `start: "vite"`, as above, so
`supatype dev` starts Vite and Kong forwards app traffic to it.

1. `npm run dev`: the Supatype stack plus Vite, started for you because the local `app.mode` is `proxy`
2. Open the URL init printed (`http://localhost:<SUPATYPE_KONG_PORT>`), the same origin as the API; Docker reaches Vite at `host.docker.internal:5173`

Init writes this local override for every static Vite app, "Decide later" projects included, so
`supatype dev` always starts Vite for an init-made project. A second terminal (`npm run vite`) is
only for a hand-written config with `app.mode: "static"` plus `vite_dev_url` and no proxy override.

## Proxy mode (alternative)

For SSR frameworks or when Supatype should spawn the dev server:

1. `app.mode: "proxy"`, `upstream: "http://localhost:5173"`, `start: "vite"`
2. `supatype dev` starts the `start` script and proxies through Kong
3. `vite_dev_url` optional if upstream already points at Vite

## Production builds

`supatype build [--env <name>] [--allow-local] [-- <command...>]` runs the production build (the
package.json `build` script through the project's package manager, or the command after `--`) with
the deployment's API URL and anon key under every prefix (`VITE_`, `PUBLIC_`, `NEXT_PUBLIC_`,
`EXPO_PUBLIC_`). It writes no file, never passes the service role key, and exits with the build's
own code. Each value comes from the first source holding it:

1. The environment: `SUPATYPE_URL` / `SUPATYPE_ANON_KEY` or any prefixed name. A host's settings win.
2. For the anon key only: `<URL>/supatype-env.json` of the server the environment's URL names
   (`SUPATYPE_URL` or a prefixed name), HTTPS for an address that is not local, a local one only
   with `--allow-local`, so CI can set just the URL. A 503 there reads `the server at <url> is not
   set up to publish its anon key: <reason>`.
3. The linked environment (`--env`, else the link's default). Cloud: the environment's address and
   the control plane's keys route (needs `supatype login` or `SUPATYPE_ACCESS_TOKEN`, as owner or
   admin). Self-host: the link's address and `<address>/supatype-env.json`, fetched over HTTPS only
   for an address that is not local.
4. `.env` recording a deployment: `PUBLIC_SUPATYPE_URL` or `API_EXTERNAL_URL`, and `ANON_KEY` (the
   server's own `.env`).

A local address in the first source holding the URL is refused, not skipped (`--allow-local`
overrides), and so is a service role key offered as the anon key. An anon key is used only for the
URL being built for: one a source holds for another deployment (a link to A beside `SUPATYPE_URL`
naming B) is listed as `skipped ... not the URL being built for`. The refusal lists every source
tried and exits 1 before the build starts. `.supatype/link.json` is gitignored, so a CI host has no
link: set `SUPATYPE_URL` in its settings and wrap the build; the anon key is fetched from that
server. Set `SUPATYPE_ANON_KEY` as well only when the server does not publish it
(`server.public_env: false`, or plain `http://`). No service role key or link is needed in CI.

Keep the real command (`vite build`) in package.json's `build` script. A bare `supatype build` run
from inside a build it started (`SUPATYPE_BUILD_ACTIVE=1`), as a `"build": "supatype build"` script
would be, refuses with ``The package.json build script calls `supatype build` itself, so running it again
would never end.`` A nested `supatype build -- <command>` still runs.

| Where it builds | What to run |
|-----------------|-------------|
| On the self-host server | `supatype build`, then `supatype self-host compose up -d` (reads `.env`) |
| Vercel | Env var `SUPATYPE_URL` (plus `SUPATYPE_ANON_KEY` if the server does not publish it); `vercel.json` `"buildCommand": "npx supatype build"`. A Next.js app needs no wrapper: see [Next.js](#nextjs) |
| Netlify | Same env var; `netlify.toml` `[build] command = "npx supatype build"` |
| Cloudflare Pages | Same variable; build command `npx supatype build` |
| GitHub Actions | `run: npx supatype build` with `env: SUPATYPE_URL: ${{ vars.SUPATYPE_URL }}` (and `SUPATYPE_ANON_KEY` if the server does not publish it) |
| A laptop, for a linked deployment | `supatype build --env production` |

**Allow the app's origin (CORS).** A self-hosted API answers browsers only from `SITE_URL`'s origin
and the listed ones. An app served anywhere else (Vercel, Netlify, Cloudflare Pages, a Next.js app on
its own server, a dev server on another port) is refused: preflight `403`, browser `Failed to fetch`.
Add its origin (`scheme://host[:port]`, each preview URL counts) to `api.corsOrigins` in
`supatype.config.ts` or `SUPATYPE_CORS_ALLOW_ORIGINS` in `.env` (comma-separated), then
`supatype self-host compose restart server`; or add it in Studio, Settings > CORS tab (no restart; a
saved list replaces the default until reset). On Supatype Cloud, add it in Studio. Supatype hosting
needs nothing: the app is on the API's origin. `supatype dev` allows every origin, so it shows only
against a deployed API. See [config.md](config.md) (`api.corsOrigins`) and
`https://www.supatype.com/docs/deploying-your-frontend.html#cors`.

`supatype keys --print frontend [--env <name>] [--allow-local]` prints the same values, one `NAME=value` per line
and nothing else on stdout, to paste into a host's settings or append to `$GITHUB_ENV`. Same
sources, same refusals; `--allow-local` takes a local stack's address. `--env` or `--allow-local`
without `--print frontend` is refused.

When Supatype serves the app, the server answers `GET /supatype-env.js` with
`window.__SUPATYPE_ENV__ = {"url":...,"anonKey":...};` (and `/supatype-env.json` with the same
object), `Cache-Control: no-cache`, whatever the app mode. `supatype init` adds
`<script src="/supatype-env.js" vite-ignore></script>` to a static app's `index.html`; with it, a build made
with no values (`npm run build`) runs on every deployment that serves it. Values the build carried
win over the script. Keep `vite-ignore`: the project has no such file, so without it every `vite
build` warns that the script `can't be bundled without type="module" attribute`. Vite drops the
attribute from the built page. Never add `type="module"` to it: Vite then tries to bundle it, and
the build fails with `Failed to resolve /supatype-env.js`. `server.public_env: false` turns both addresses off (404) for an API-only
project; the anon key is public either way.

### Next.js

`next build` prerenders without the deployment's values, so a Next.js app takes them at run time.
`supatype init` writes, for an App Router app (under `src/app` when that is where it lives, and
`route.js` without a `tsconfig.json`):

```ts
// app/supatype-env.js/route.ts
export { GET } from "@supatype/ssr/next"
export const dynamic = "force-dynamic" // in this file: Next ignores a re-exported segment config
```

and, first inside the root layout's `<body>`,
`<Script src="/supatype-env.js" strategy="beforeInteractive" />` with
`import Script from "next/script"`, plus `@supatype/ssr` in dependencies. A layout it cannot edit
safely is left alone and the two lines are printed. For a static export (`output: "export"` in
`next.config`) init writes no route, layout script or dependency, and prints `supatype build -- next
build` or Supatype hosting. A Pages Router app gets nothing written; init prints the steps: the same route under `app/`, the `<Script>` inside `<Head>` in
`pages/_document.tsx`, and the dependency.

`GET` answers `window.__SUPATYPE_ENV__ = {"url":...,"anonKey":...};` from `SUPATYPE_URL` and
`SUPATYPE_ANON_KEY` in the running server's environment, `Cache-Control: no-cache`. 404 `no-store`
only when `SUPATYPE_PUBLIC_ENV=false`; 503 `no-store` naming the variable when `SUPATYPE_URL` or
`SUPATYPE_ANON_KEY` is unset (`public env unavailable: SUPATYPE_ANON_KEY is not set on this
server`) or the anon key is a service role token. The Supatype server answers its own
`/supatype-env.js` the same way. `createServerClient({ cookies })` defaults its address and anon
key to the same two variables, then to `NEXT_PUBLIC_SUPATYPE_URL` / `NEXT_PUBLIC_SUPATYPE_ANON_KEY`
(`createServerClient(url, anonKey, { cookies })` still works). With neither, its first request
throws ``Supatype client has no API address and anon key. It was given none, and it is running on
a server, where there is no page to read them from.`` and names `SUPATYPE_URL` and
`SUPATYPE_ANON_KEY`. In `next dev` the route answers from `.env.development.local`, where
`supatype dev`, `init` and `keys --write` put the local stack's `SUPATYPE_URL` and
`SUPATYPE_ANON_KEY`.

So on Vercel, Netlify or a Node server running `next start`: set `SUPATYPE_URL` and
`SUPATYPE_ANON_KEY` where the app runs, keep the build command `next build`, and leave the
`NEXT_PUBLIC_SUPATYPE_*` names unset in production (a value fixed into the build wins over the
route's). One build then runs against any deployment. A static export has no server for the
route: `supatype build -- next build`, or let Supatype host the export
(`supatype app add --static ./out`), whose server answers `/supatype-env.js` itself (add the
`<Script>` to the root layout).

See [self-host.md](self-host.md) and `examples/self-host/README.md` for TLS, DNS, and compose, and
the docs page "Deploy your frontend" (`https://www.supatype.com/docs/deploying-your-frontend.html`).

## Query patterns

```typescript
const { data: posts } = await supatype.from("posts").select("*")
await supatype.from("posts").insert({ title: "Hello", author_id: userId })   // data: null
await supatype.from("posts").update({ title: "Updated" }).eq("id", postId)
await supatype.from("posts").delete().eq("id", postId)

// Rows come back only after .select(); .single() and .maybeSingle() only after .select()
const { data: post } = await supatype.from("posts").insert({ title: "Hello", author_id: userId }).select("id, title").single()

// Writes take every read filter: gt/gte/lt/lte, like/ilike, in, is, not, contains, match, or
await supatype.from("posts").update({ status: "archived" }).lt("created_at", cutoff).select("id")
const { data: gone } = await supatype.from("posts").delete().or("slug.eq.a,slug.eq.b").select("id")

// Array columns: contains/containedBy send a Postgres array literal; an object goes as jsonb
await supatype.from("posts").select("*").contains("tags", ["news", "featured"])

// count is null unless asked for, never NaN
const { count } = await supatype.from("posts").select("*", { count: "exact", head: true })
```

Access rules in `schema/index.ts` enforce what each role can do.

### Client behaviour to rely on

- **Writes return no rows unless asked.** `insert`, `update`, `upsert` and `delete` send no
  `return=representation` and resolve to `data: null` (and `count: null`), as postgrest-js does.
  Chain `.select()` or `.select(columns)` to get the written rows. Returning a row needs the right
  to read it, so a table whose rules let a caller create but not read (an anon order form) accepts
  a plain insert and refuses one with `.select()`. `.single()` and `.maybeSingle()` on a write are
  a type error until `.select()` is chained; from untyped code they answer an error and send nothing.
- **401 resends.** A request refused with 401 is sent again only when the server called the token
  expired or invalid (`PGRST301`, `PGRST303`, or "JWT expired"), there was a session to refresh,
  and the refresh produced a different token. A row rule refusing an anon write (401 `42501`) is
  not sent twice.
- **Errors.** Every call returns `{ data, error }`. REST errors carry PostgREST 14 codes: database
  errors as bare SQLSTATE (`23505`, `23503`, `42501`), PostgREST's own as `PGRST...`
  (`PGRST116` from `.single()`, `PGRST205` unknown table, `PGRST204` unknown column, `PGRST301`
  bad token, `PGRST303` expired token). Constants: `PostgrestErrorCodes` from `@supatype/client`.
  Never compare against `PGRST23505`-style codes; they are not sent.
- **Auth errors** carry the server's code in `error.code` on every auth method:
  `invalid_credentials`, `email_not_confirmed`, `weak_password`, `user_already_exists`,
  `otp_expired`. Branch on the code, not the message.
- **Auth events:** `SIGNED_IN`, `SIGNED_OUT`, `TOKEN_REFRESHED`, `USER_UPDATED` (after
  `updateUser`), `PASSWORD_RECOVERY` (a reset link or `verifyOtp({ type: "recovery" })` produced a
  session), `MFA_CHALLENGE_VERIFIED`.
- **Timeouts and retries.** `createClient({ timeout, retry })`: `timeout` (default 30000 ms)
  applies to every HTTP request; `retry` (default true) retries only GET and HEAD (plus storage
  `list` and `createSignedUrl`) up to 3 times on a dropped connection, 5xx or 429. Writes, sign-in
  and `rpc`/`graphql`/`functions.invoke` are sent once unless the call passes `idempotent: true`.
  A transport failure comes back as `error.code` `NETWORK_TIMEOUT`, `NETWORK_CONNECTION_REFUSED`,
  `NETWORK_DNS_FAILURE`, `NETWORK_ERROR` or `RATE_LIMITED`.
- **Creating on a drafts model** (`versions` with drafts). Import `createClient` from the generated
  `supatype/generated/client.ts`: it tells the client which models keep drafts, and `insert` (also through
  `useMutation` / `createMutation`) then goes through `supatype.create_record` for one record, or
  `supatype.create_records` for several, all or none in one call. With `.select()` (or
  `useMutation`'s `select`) it returns the rows read back from the draft view in the order sent,
  with that select; without it, `data: null`. A plain `POST` asking for the row
  back is refused with `42501` when the read rule hides unpublished records
  (`Lte<"published_at", Now>`), because Postgres checks the returned row against it before anything
  makes it visible to its author; the gateway's refusal carries a `hint` naming both functions, and
  `error.hint` holds it. `upsert` stays a plain write, since neither function can say what a
  conflict does. Passing `published_at` publishes the record at once, on purpose (localized fields
  still wait for `publish`).
- **Editing on a drafts model.** With the generated client, `update(values).eq(...)` saves a new
  draft of each record the filters match, through `supatype.save_drafts` (all or none in one call,
  each merged onto the record's newest version as Studio saves one), and with `.select()` returns
  the drafts read from the draft view. The live rows do not change until a version is published:
  `update(values, { publish: true })` saves and publishes in the same call, and the history records
  the version that went live (`useMutation`'s `mutate(values, { filter, publish: true })` too). The
  option is typed only on drafts models. Without the generated client, or through raw PostgREST or
  GraphQL, a direct update of a drafts model's table by `anon` or `authenticated` is refused with
  `42501` ("posts has drafts: save a draft with supatype.create_draft or the client's update, then
  publish"); the service role and Studio's editors still write the live row.
- **GraphQL** (`supatype.graphql`) runs as the caller, under the same access rules as REST.
- **GraphQL JSON fields come back as values.** pg_graphql sends every json/jsonb column (rich text,
  blocks, json) as its `JSON` scalar, a JSON-encoded string. `supatype.graphql` reads the schema
  once per role and decodes each field of that type the query selects, through aliases, named and
  inline fragments, nested relations and lists, so do not `JSON.parse` them. A field it cannot place
  stays as returned (added since the schema was read, more than one operation in the document, or
  introspection refused). Type the answer with `supatype.graphql<T>(query)`, building `T` from
  `TableRow<"talk">` (unchecked at runtime). Variables are not encoded: a json argument still takes
  a string. Studio's GraphQL tabs show the decoded values. Another GraphQL client can do the same
  with the client's `GRAPHQL_SCHEMA_QUERY`, `readGraphqlSchema` and `decodeGraphqlJsonFields`.
- **GraphQL relations use the schema's field names** (from 0.7.0, written on each push): a
  `belongsTo` field is the to-one field under its declared name, and the far model's `hasMany` or
  `hasOne` names the reverse, so `talks: HasMany<Talk>` on `Speaker` is `talks`, not
  `talkCollection` (still a connection, `talks { edges { node { title } } }`). An end the schema
  does not name, an ambiguous reverse (two keys to one model with an inverse naming neither column),
  or a name that clashes with a column keeps pg_graphql's default. `Unknown field "talks"` means
  the project has not pushed since upgrading.
- **Realtime status.** Signing in or out swaps the socket; every channel reports `SUBSCRIBING`
  until the new socket rejoins, then `SUBSCRIBED`. Each `from(table).subscribe()` gets its own
  channel. React's `useSubscription` returns the raw channel status and shares a channel between
  hooks given the same name; the Vue, Svelte and Solid bindings return `connecting`, `connected`,
  `disconnected` or `error` plus an `error` that clears on reconnect.
- **`@supatype/client/bindings`** is an internal subpath the framework bindings share
  (`watchTable`, `subscribeToTable`, `subscriptionViewOf`, `applyRowChange`). App code should use
  `from(table).subscribe()` or a binding, not this subpath.
- **JWT secret.** PostgREST 14 needs `JWT_SECRET` of at least 32 characters; `supatype dev` and
  `supatype self-host compose up` refuse a shorter one with
  `JWT_SECRET in .env is N characters, and the REST API needs at least 32.` Fix: a longer secret,
  then `supatype keys --force`.

## Framework packages (use these instead of hand-rolling)

Supatype ships first-party bindings. Prefer them over wiring the raw client by hand:

| Package | What it gives you |
|---------|-------------------|
| `@supatype/react` | Provider + hooks: `SupatypeProvider`, `useSupatype`, `useAuth`, `useQuery`, `useMutation`, `useSubscription`, `useFunction`, `useLivePreview`, `RichText` |
| `@supatype/react-auth` | Prebuilt, accessible auth UI: `LoginForm`, `SignUpForm`, `ForgotPasswordForm`, `UpdatePasswordForm`, `MagicLinkForm`, `OAuthButton` |
| `@supatype/vue` | Composables: `useAuth`, `useQuery`, `useMutation`, `useSubscription` |
| `@supatype/solid` | Primitives: `createAuth`, `createQuery`, `createMutation`, `createSubscription` |
| `@supatype/svelte` | Stores: `createAuth`, `createQuery`, `createMutation`, `createSubscription` |
| `@supatype/ssr` | Cookie-based client for Server Components, Route Handlers, middleware (address and anon key default to `SUPATYPE_URL` / `SUPATYPE_ANON_KEY`); `@supatype/ssr/next` exports `GET` for `app/supatype-env.js/route.ts` ([Next.js](#nextjs)) |
| `@supatype/ui` | React components styled with Tailwind (`Button`, `Input`, `Card`, `Badge`, `Skeleton`, `ThemeProvider`), plus a Lexical `RichTextEditor` at `@supatype/ui/rich-text`. Needs Tailwind set up to see it: see [`@supatype/ui` setup](#supatypeui-setup) |

> **Don't reimplement auth forms or auth state by hand.** Use `@supatype/react-auth` for the UI and `@supatype/react`'s `useAuth` for state. Drop to the raw client only for app-specific data access not covered by the hooks.

## React integration (`@supatype/react`)

```bash
npm install @supatype/client @supatype/react @supatype/react-auth
```

### Provider

Wrap the app once, near the root, with the typed client:

```tsx
import { SupatypeProvider } from "@supatype/react"
import { supatype } from "./lib/supatype" // createClient(...) from the generated client

export function App() {
  return (
    <SupatypeProvider client={supatype}>
      <Routes />
    </SupatypeProvider>
  )
}
```

All hooks and `@supatype/react-auth` components must render inside this provider.

### Hooks

```tsx
import { useAuth, useLivePreview, useQuery, useMutation, useSubscription, useSupatype } from "@supatype/react"

const { user, session, loading, signUp, signIn, signInWithOAuth, signInWithOtp, signOut } = useAuth()

const { data, error, loading, refetch } = useQuery("posts", {
  select: "*",
  filter: { author_id: userId },
  order: { column: "created_at", ascending: false },
  enabled: Boolean(userId),
})

const { mutate: createPost, loading: saving } = useMutation("posts", "insert")
await createPost({ title: "Hello", author_id: userId })   // data: null
// Rows back only when asked: `select: true` for every column, or the columns as .select() takes them
const { data: created } = await createPost({ title: "Hello", author_id: userId }, { select: "id, title" })
const { mutate: editPost } = useMutation("posts", "update")
await editPost({ title: "Hello again" }, { filter: { id: postId }, publish: true })

useSubscription<Post>("feed", {
  event: "INSERT",
  table: "posts",
  callback: (payload) => append(payload.new),
})

// Database from the generated types: import type { Database } from "../types/database"
const client = useSupatype<Database>() // escape hatch

// Unsaved Studio keystrokes, applied only from the framing Studio window at a trusted origin.
// Defaults to the provider client's URL (self-hosted Studio is /studio/ on it). On Cloud, Studio is
// on the platform origin, so name it.
const { data: post, isPreview } = useLivePreview({
  initialData: serverPost,
  model: "Post", // the model name Studio sends, as the schema declares it
  studioOrigin: "https://studio.supatype.com",
})
```

## Auth UI components (`@supatype/react-auth`)

```tsx
import {
  LoginForm, SignUpForm, ForgotPasswordForm, UpdatePasswordForm, MagicLinkForm, OAuthButton,
  usePasswordRecovery, type AuthFormClassNames,
} from "@supatype/react-auth"

// The app's own classes, defined once and given to every form.
const authClassNames: AuthFormClassNames = {
  title: "form-title",
  field: "field",
  label: "field-label",
  input: "input",
  submit: "btn btn-primary",
  error: "note note-error",
}

<LoginForm
  className="form"
  classNames={authClassNames}
  onSuccess={(session) => navigate("/")}
  onError={(err) => console.error(err.message)}
/>

<SignUpForm
  className="form"
  classNames={authClassNames}
  metadata={{ display_name }}
  onSuccess={(session) => { if (session) navigate("/onboarding") }}
/>

<OAuthButton provider="github" redirectTo="/dashboard" />

// Emails a reset link (POST /recover); then "Check your email for the password reset link."
<ForgotPasswordForm className="form" classNames={authClassNames} redirectTo={window.location.origin} />

// Emails a sign-in link (signInWithOtp, POST /otp); then "Check your email for the magic link."
<MagicLinkForm className="form" classNames={authClassNames} redirectTo={window.location.origin} />

// The reset link's landing: sets the new password (updateUser, PUT /user) on the session it carried.
{recovery.active && <UpdatePasswordForm className="form" classNames={authClassNames} onSuccess={recovery.finish} />}
```

**The forms ship no stylesheet.** There is no CSS to import and nothing to add to Tailwind `content`. `className` styles only the `<form>`; `classNames` puts a class on each element inside it (`title`, `error`, `field`, `label`, `input`, `submit`, and `message` for the line a form shows in its place when done: `SignUpForm` awaiting confirmation, `ForgotPasswordForm` and `MagicLinkForm` once the email is sent, `UpdatePasswordForm` once the password is set). Render them without `classNames` in an app that only styles classes and they show browser defaults: labels inline beside narrow inputs and a grey button. Skip `classNames` only if the app styles bare `label`/`input`/`button` elements globally. `OAuthButton` has default styles only when no `className` is given.

**Don't write an OAuth callback handler.** The client finishes the sign-in from the redirect URL on start (`auth: { detectSessionInUrl }`, default `true`, as in supabase-js), cleans the URL and emits `SIGNED_IN`, so `useAuth()` shows the user. A refusal the server sends back is `useAuth().error` (with `provider`), and `OAuthButton`'s `onError` receives it, as it does a provider the project has not enabled.

**Password reset is two screens.** `ForgotPasswordForm` sends the link; the link lands signed in, and the client emits `PASSWORD_RECOVERY` after `SIGNED_IN`. `usePasswordRecovery()` turns it into state: show `UpdatePasswordForm` instead of the app while it is active, or the user lands inside the app with the password they forgot. `redirectTo` on either email form is honoured when it is on the site URL's host (or the auth server's redirect allow list); otherwise the link lands on the site URL. Each email form's `onSuccess` gets the address; `UpdatePasswordForm`'s gets the updated user.

```tsx
import { usePasswordRecovery, UpdatePasswordForm } from "@supatype/react-auth"

const recovery = usePasswordRecovery() // beside useAuth(), from the first render
if (recovery.active) return <UpdatePasswordForm onSuccess={recovery.finish} />
```

## Gotcha: keep a single `@supatype/client` version

`@supatype/react` and `@supatype/react-auth` declare their own `@supatype/client` dependency. If your app installs a **newer** client than the one they were published against, TypeScript fails with:

```
Type 'SupatypeClient<Database>' is not assignable to type 'SupatypeClient<any>'
```

Force one client version across the tree with an npm `overrides` entry in `package.json`:

```json
{
  "overrides": {
    "@supatype/client": "$@supatype/client"
  }
}
```

`$@supatype/client` pins the transitive copy to whatever version your app's direct dependency resolves to. Run `npm install` afterwards. Pin `@supatype/*` packages to the same release when mixing CLI, client, types, and framework bindings.

## `@supatype/ui` setup

`Button`, `Input`, `Card`, `Badge` and `Skeleton` are styled with Tailwind utility classes from the
default palette. The package ships those class names in its JavaScript, not as compiled CSS, so the
app's Tailwind build has to scan it; without that the components render unstyled. React 18 or 19
is a peer dependency.

Tailwind v4 does not scan `node_modules`. Add `@source` to the CSS file that imports Tailwind; the
path is relative to that CSS file, not the project root:

```css
/* app/globals.css */
@import "tailwindcss";
@source "../node_modules/@supatype/ui/dist";
```

Tailwind v3: add the package to `content` in `tailwind.config.js`:

```js
export default {
  content: ["./src/**/*.{ts,tsx}", "./node_modules/@supatype/ui/dist/**/*.js"],
}
```

`ThemeProvider` toggles a `dark` class on `<html>`, so make `dark:` follow it: v4
`@custom-variant dark (&:where(.dark, .dark *));` after `@import "tailwindcss";`, v3
`darkMode: "class"`.

Import the package stylesheet once, before your own CSS (it holds the rich text editor's styles,
themed with `--su-rt-*` custom properties):

```ts
import "@supatype/ui/styles.css"
```

`RichTextEditor` has its own entry, so an app that never uses it needs no Lexical. To use it,
install the Lexical peers (optional peer dependencies, so nothing installs or warns about them):

```bash
npm install lexical @lexical/react @lexical/rich-text @lexical/list @lexical/link @lexical/selection
```

```tsx
import "@supatype/ui/styles.css"
import { RichTextEditor } from "@supatype/ui/rich-text"
import { emptyRichTextDocument, type SerializedEditorState } from "@supatype/ui"
```

Importing `RichTextEditor` from `@supatype/ui` fails: it moved to `@supatype/ui/rich-text`. The
rich text helpers (`emptyRichTextDocument`, `stringToRichTextDocument`, `normalizeRichTextDefault`,
`richTextIsEmpty`) and the `SerializedEditorState` types stay in `@supatype/ui`. `value` is read
once, on mount; change `documentKey` to load another document, and pass `editable={false}` to
render read only. An `Input` with no `id` gets one from `React.useId()`, and with `error` sets
`aria-invalid` and `aria-describedby` (`<id>-error`).

## Dev modes summary

| Mode | Config | Use when |
|------|--------|----------|
| Static + `vite_dev_url` | `app.mode: "static"`; `supatype dev` does not start Vite, so run `npm run vite` beside it | Only a hand-written config: init never leaves a Vite app this way; Kong serves built assets in prod |
| Proxy | `app.mode: "proxy"`, `upstream`, `start: "vite"` | One `npm run dev` starts the stack and Vite (what init writes into `supatype.local.config.ts` for every Vite app) |
| Static SSG (Astro, etc.) | `build.framework`, `static_dir` | `supatype build` then compose serves `dist/` |

Local dev URL: the one init and `supatype dev` print, `http://localhost:<SUPATYPE_KONG_PORT>` from
`.env` (18473 or the next free port when init ran).
