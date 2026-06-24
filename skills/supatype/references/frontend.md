# Frontend integration

Reference layout: **`test-app`** in the Supatype repo (`supatype init --mode standalone` + static site + `vite_dev_url`).

## Add dependencies

```bash
npm install @supatype/client @supatype/cli @supatype/types
npm install -D vite @vitejs/plugin-react typescript  # Vite + React example
```

Supatype is in **early development**. For now, see what the latest alpha is on npm and install that:

```bash
npm view @supatype/cli versions   # pick the highest 0.1.0-alpha.*
npm install @supatype/client@<version> @supatype/cli@<version> @supatype/types@<version>
```

Use `file:` links only when developing the CLI itself.

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

See `references/self-host.md` and the `test-app/DEPLOY.md` runbook for TLS, DNS, and compose gotchas.

## Query patterns

```typescript
const { data: posts } = await supatype.from("posts").select("*")
await supatype.from("posts").insert({ title: "Hello", author_id: userId })
await supatype.from("posts").update({ title: "Updated" }).eq("id", postId)
await supatype.from("posts").delete().eq("id", postId)
```

Access rules in `schema/index.ts` enforce what each role can do.
