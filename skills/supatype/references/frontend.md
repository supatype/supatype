# Frontend integration

## Add dependencies

```bash
npm install @supatype/client
# plus your framework: astro, next, vite, etc.
```

## Configure types output

In `supatype.config.ts`:

```typescript
export default defineConfig({
  // ...
  output: { types: "src/lib/database.ts" },
  app: {
    mode: "static",       // or "proxy" for SSR/dev server
    static_dir: "./dist", // build output directory
  },
  build: {
    framework: "astro",   // astro | vite | nextjs | sveltekit | nuxt | static
    buildCommand: "astro build",
    outputDirectory: "dist",
    env: {
      PUBLIC_SUPATYPE_URL: process.env["PUBLIC_SUPATYPE_URL"] ?? "",
      PUBLIC_SUPATYPE_ANON_KEY: process.env["ANON_KEY"] ?? "",
    },
  },
})
```

Run `supatype push` after schema changes to refresh types.

## Client setup

```typescript
import { createClient } from "@supatype/client"
import type { Database } from "../lib/database"

export const supatype = createClient<Database>({
  url: import.meta.env.PUBLIC_SUPATYPE_URL,
  anonKey: import.meta.env.PUBLIC_SUPATYPE_ANON_KEY,
})
```

## Query patterns

```typescript
// Select
const { data: posts } = await supatype.from("posts").select("*")

// Insert
await supatype.from("posts").insert({ title: "Hello", author_id: userId })

// Update (with RLS enforced server-side)
await supatype.from("posts").update({ title: "Updated" }).eq("id", postId)

// Delete
await supatype.from("posts").delete().eq("id", postId)
```

Access rules in `schema/index.ts` enforce what each role can do.

## Dev modes

### Static site (Astro, Vite SSG)

1. Set `app.mode: "static"` and `static_dir` to build output
2. `npm run build` then `supatype dev` or self-host compose serves static files via Kong

### Proxy mode (SSR / dev server)

1. Set `app.mode: "proxy"`, `upstream: "http://localhost:3000"`, `start: "dev"`
2. `supatype dev` starts your app command and proxies through Kong
3. For Vite HMR: `vite_dev_url: "http://127.0.0.1:5173"`

## Local dev URL

Docker default: `http://localhost:18473` (check `SUPATYPE_KONG_PORT` in `.env`).

Set in `.env`:

```bash
PUBLIC_SUPATYPE_URL=http://localhost:18473
```

## Example: elmsideretreat pattern

Real project using Astro + Docker self-host:

- `provider: "docker"`
- `app.mode: "static"`, `static_dir: "./dist"`
- `build.framework: "astro"`
- `output.types: "src/lib/database.ts"`
- Production: `supatype self-host compose up -d`
