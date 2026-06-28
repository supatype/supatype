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
// supatype.config.ts — committed
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
  // Optional — for `supatype deploy`:
  build: {
    framework: "vite",
    buildCommand: "vite build",
    outputDirectory: "dist",
    env: { VITE_SUPATYPE_ANON_KEY: process.env["ANON_KEY"] ?? "" },
  },
})

// supatype.local.config.ts — gitignored
export default { server: { mode: "dev" } } satisfies Partial<SupatypeConfig>
```

**Do not pin `versions` for Docker** unless you need a specific release — omit the block so compose uses `:latest` image tags.

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

1. `npm run dev` — one terminal: Supatype stack + auto-spawned Vite (when `app.mode` is `proxy` locally)
2. Open **http://localhost:18473** — same origin as API; Docker rewrites upstream to `host.docker.internal:5173`

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
```

Access rules in `schema/index.ts` enforce what each role can do.

## Framework packages (use these instead of hand-rolling)

Supatype ships first-party bindings — prefer them over wiring the raw client by hand:

| Package | What it gives you |
|---------|-------------------|
| `@supatype/react` | Provider + hooks: `SupatypeProvider`, `useSupatype`, `useAuth`, `useQuery`, `useMutation`, `useSubscription`, `useFunction`, `useLivePreview`, `RichText` |
| `@supatype/react-auth` | Prebuilt, accessible auth UI: `LoginForm`, `SignUpForm`, `OAuthButton` |
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
import { useAuth, useQuery, useMutation, useSubscription, useSupatype } from "@supatype/react"

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
```

## Auth UI components (`@supatype/react-auth`)

```tsx
import { LoginForm, SignUpForm, OAuthButton } from "@supatype/react-auth"

<LoginForm
  className="auth-form"
  onSuccess={(session) => navigate("/")}
  onError={(err) => console.error(err.message)}
/>

<SignUpForm
  className="auth-form"
  metadata={{ display_name }}
  onSuccess={(session) => { if (session) navigate("/onboarding") }}
/>

<OAuthButton provider="github" redirectTo="/dashboard" />
```

Form components apply no styles of their own — pass `className` and style descendants. `OAuthButton` has default styles only when no `className` is given.

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
