# Frontend integration

Reference layout: `supatype init --mode standalone` (static site + `vite_dev_url`). Maintainer fixture: **`examples/self-host/`** in the Supatype repo (compose-first, proxy mode).

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

Committed `supatype.config.ts` targets production; `supatype.local.config.ts` (gitignored) keeps local HTTP:

```typescript
// supatype.config.ts (committed)
export default defineConfig({
  project: { name: "my-app" },
  provider: "docker",
  database: { provider: "docker" },
  server: {
    mode: "standalone",
    port: 54321,
    domain: "demo.supatype.com",
    tls: { email: "you@example.com", provider: "kong" },
  },
  app: {
    mode: "static",
    static_dir: "./dist",
    vite_dev_url: "http://127.0.0.1:5173",  // local HMR through Kong
  },
  environments: { default: "production" },
  email: { provider: "console" },
  storage: { provider: "local", local_path: ".supatype/storage" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
  output: { types: "supatype/generated/database.ts" },
  // Optional, for `supatype deploy`:
  build: {
    framework: "vite",
    buildCommand: "vite build",
    outputDirectory: "dist",
    env: { VITE_SUPATYPE_ANON_KEY: process.env["ANON_KEY"] ?? "" },
  },
})

// supatype.local.config.ts (gitignored)
export default { server: { mode: "dev" } } satisfies Partial<SupatypeConfig>
```

**Do not pin `versions` for Docker** unless you need a specific release. Omit the block so compose uses `:latest` image tags.

Run `supatype push` after schema changes to refresh types.

## Client setup (static / same-origin)

When Kong serves the SPA and API together, use the page origin (no CORS):

```typescript
import { createClient } from "@supatype/client"
import type { Database } from "../supatype/generated/database"

export const supatype = createClient<Database>({
  url: typeof window !== "undefined" ? window.location.origin : "http://localhost:18473",
  anonKey: import.meta.env.VITE_SUPATYPE_ANON_KEY as string,
})
```

Ensure `.env` has `VITE_SUPATYPE_ANON_KEY` (copy from `ANON_KEY` after `supatype keys`). `supatype dev` may also write `PUBLIC_SUPATYPE_ANON_KEY`.

## Vite config

```typescript
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
})
```

## package.json scripts

From `supatype init`:

```json
{
  "scripts": {
    "dev": "supatype dev",
    "vite": "vite",
    "build": "vite build",
    "push": "supatype push",
    "seed": "tsx seed.ts"
  }
}
```

## Local dev workflow (Vite)

**Production** (`supatype.config.ts`): `app.mode: "static"`, `static_dir: "./dist"`.

**Local** (`supatype.local.config.ts`): override to **proxy** so `supatype dev` starts Vite and Kong forwards app traffic:

```typescript
// supatype.local.config.ts
export default {
  server: { mode: "dev" },
  app: {
    mode: "proxy",
    upstream: "http://127.0.0.1:5173",
    start: "vite",
    vite_dev_url: "http://127.0.0.1:5173",
  },
} satisfies Partial<SupatypeConfig>
```

```json
{ "scripts": { "dev": "supatype dev", "vite": "vite", "build": "vite build" } }
```

1. `npm run dev` in one terminal: Supatype stack + auto-spawned Vite (when `app.mode` is `proxy` locally)
2. Open **http://localhost:18473**, the same origin as the API; Docker rewrites upstream to `host.docker.internal:5173`

For static-only local dev (no proxy), use `static` + `vite_dev_url` and run `npm run vite` in a second terminal instead.

## Proxy mode (alternative)

For SSR frameworks or when Supatype should spawn the dev server:

1. `app.mode: "proxy"`, `upstream: "http://localhost:5173"`, `start: "vite"`
2. `supatype dev` starts the `start` script and proxies through Kong
3. `vite_dev_url` optional if upstream already points at Vite

## Production static build

```bash
npm run build
supatype self-host compose up -d
```

See [references/self-host.md](references/self-host.md) and `examples/self-host/README.md` for TLS, DNS, and compose.

## Query patterns

```typescript
const { data: posts } = await supatype.from("posts").select("*")
await supatype.from("posts").insert({ title: "Hello", author_id: userId })
await supatype.from("posts").update({ title: "Updated" }).eq("id", postId)
await supatype.from("posts").delete().eq("id", postId)

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
  `supatype/client.ts`: it tells the client which models keep drafts, and `insert` (also through
  `useMutation` / `createMutation`) then goes through `supatype.create_record` for one record, or
  `supatype.create_records` for several, all or none in one call, and returns the rows read back
  from the draft view in the order sent, with the insert's select. A plain `POST` asking for the row
  back is refused with `42501` when the read rule hides unpublished records
  (`Lte<"published_at", Now>`), because Postgres checks the returned row against it before anything
  makes it visible to its author; the gateway's refusal carries a `hint` naming both functions, and
  `error.hint` holds it. `upsert` stays a plain write, since neither function can say what a
  conflict does. Passing `published_at` publishes the record at once, on purpose (localized fields
  still wait for `publish`).
- **GraphQL** (`supatype.graphql`) runs as the caller, under the same access rules as REST.
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
  then `supatype keys --write --force`.

## Framework packages (use these instead of hand-rolling)

Supatype ships first-party bindings. Prefer them over wiring the raw client by hand:

| Package | What it gives you |
|---------|-------------------|
| `@supatype/react` | Provider + hooks: `SupatypeProvider`, `useSupatype`, `useAuth`, `useQuery`, `useMutation`, `useSubscription`, `useFunction`, `useLivePreview`, `RichText` |
| `@supatype/react-auth` | Prebuilt, accessible auth UI: `LoginForm`, `SignUpForm`, `ForgotPasswordForm`, `UpdatePasswordForm`, `MagicLinkForm`, `OAuthButton` |
| `@supatype/vue` | Composables: `useAuth`, `useQuery`, `useMutation`, `useSubscription` |
| `@supatype/solid` | Primitives: `createAuth`, `createQuery`, `createMutation`, `createSubscription` |
| `@supatype/svelte` | Stores: `createAuth`, `createQuery`, `createMutation`, `createSubscription` |
| `@supatype/ssr` | Cookie-based client for Server Components, Route Handlers, middleware |
| `@supatype/ui` | Shared React component library (Tailwind + Radix primitives) |
| `@supatype/navigation` | Shared `Header` / `Footer` components |

> **Don't reimplement auth forms or auth state by hand.** Use `@supatype/react-auth` for the UI and `@supatype/react`'s `useAuth` for state. Drop to the raw client only for app-specific data access not covered by the hooks.

## React integration (`@supatype/react`)

```bash
npm install @supatype/client @supatype/react @supatype/react-auth
```

### Provider

Wrap the app once, near the root, with the typed client:

```tsx
import { SupatypeProvider } from "@supatype/react"
import { supatype } from "./lib/supatype" // createClient<Database>(...)

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
await createPost({ title: "Hello", author_id: userId })

useSubscription<Post>("feed", {
  event: "INSERT",
  table: "posts",
  callback: (payload) => append(payload.new),
})

const client = useSupatype<Database>() // escape hatch

// Unsaved Studio keystrokes, applied only from the framing Studio window at a trusted origin.
// Defaults to the provider client's URL (self-hosted Studio is /studio/ on it). On Cloud, Studio is
// on the platform origin, so name it.
const { data: post, isPreview } = useLivePreview({
  initialData: serverPost,
  model: "post",
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

## Dev modes summary

| Mode | Config | Use when |
|------|--------|----------|
| Static + `vite_dev_url` | `app.mode: "static"`, run Vite in second terminal | Simple SPA; Kong serves built assets in prod |
| Proxy | `app.mode: "proxy"`, `upstream`, `start: "vite"` | One `supatype dev` command spawns Vite + stack |
| Static SSG (Astro, etc.) | `build.framework`, `static_dir` | `npm run build` then compose serves `dist/` |

Local dev URL: `http://localhost:18473` (or `SUPATYPE_KONG_PORT` in `.env`).
