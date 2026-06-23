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

All hooks and `@supatype/react-auth` components must render inside this provider. The provider accepts `SupatypeClient<any>`, so any `createClient<Database>()` instance is fine.

### Hooks

```tsx
import { useAuth, useQuery, useMutation, useSubscription, useSupatype } from "@supatype/react"

// Auth state + methods (subscribes to auth changes automatically)
const { user, session, loading, signUp, signIn, signInWithOAuth, signInWithOtp, signOut } = useAuth()
// signIn/signUp resolve to { data: { session, user }, error }
await signIn({ email, password })
await signUp({ email, password, options: { data: { display_name: "Ada" } } })

// Reads — re-runs when options change; supports polling + pagination
const { data, error, count, loading, refetch } = useQuery("check_in", {
  select: "*",
  filter: { team_id: teamId, day: today },     // simple equality filters
  order: { column: "created_at", ascending: false },
  limit: 20,
  offset: 0,
  enabled: Boolean(teamId),                     // skip until ready
  refetchInterval: 15000,                       // optional polling (ms)
})

// Writes — insert | update | delete | upsert
const { mutate: createCheckIn, loading: saving } = useMutation("check_in", "insert")
await createCheckIn({ team_id, day, today_text })

const { mutate: removeCheckIn } = useMutation("check_in", "delete")
await removeCheckIn(undefined, { filter: { id: checkInId } }) // filter required for update/delete

// Realtime
useSubscription<CheckIn>("feed", {
  event: "INSERT",          // "*" | "INSERT" | "UPDATE" | "DELETE"
  table: "check_in",
  filter: `team_id=eq.${teamId}`,
  callback: (payload) => append(payload.new),
})

// Escape hatch — the raw typed client for anything the hooks don't cover
const client = useSupatype<Database>()
```

`useQuery`/`useMutation` are generic over the table name and return `Row` types from your generated `Database`. The `mutate` filter only does equality (`.eq`); for richer filters use `useSupatype()` and the query builder directly.

## Auth UI components (`@supatype/react-auth`)

Prebuilt, accessible forms wired to `useAuth()`. They render minimal semantic markup (`<form>` → `<h2>` title, `<label>`+`<input>` rows, submit `<button>`, and a `role="alert"` error line), so you style them via `className` and child selectors.

```tsx
import { LoginForm, SignUpForm, OAuthButton } from "@supatype/react-auth"

<LoginForm
  className="auth-form"
  labels={{ title: "Welcome back", email: "Email", password: "Password", submit: "Sign in", errorPrefix: "" }}
  onSuccess={(session) => navigate("/")}
  onError={(err) => console.error(err.message)}
/>

<SignUpForm
  className="auth-form"
  labels={{ title: "Create account", submit: "Sign up", successMessage: "Check your email to confirm." }}
  metadata={{ display_name }}      // → stored on user_metadata
  onSuccess={(session) => {
    if (session) navigate("/onboarding")
    // session === null ⇒ email confirmation required; the form shows successMessage
  }}
/>

<OAuthButton provider="github" redirectTo="/dashboard" />
<OAuthButton provider="google" popup />
<OAuthButton provider="apple" className="dark-btn">Continue with Apple</OAuthButton>
```

Component props:

| Component | Props |
|-----------|-------|
| `LoginForm` | `onSuccess(session)`, `onError(error)`, `className`, `labels { title, email, password, submit, errorPrefix }` |
| `SignUpForm` | `onSuccess(session \| null)`, `onError(error)`, `className`, `labels { title, email, password, submit, successMessage }`, `metadata` (→ `user_metadata`) |
| `OAuthButton` | `provider` (e.g. `"github"`/`"google"`/`"apple"`), `redirectTo`, `popup`, `disabled`, `children`, `className`, `onError` |

Styling notes:

- The form components apply **no** styles of their own — pass `className` and target the `<h2>`, `label`, `input`, `button`, and `[role="alert"]` descendants from your CSS.
- To hide the built-in heading, set `labels.title` to `""` (it still renders an empty `<h2>` — `display: none` it) and supply your own heading outside the form.
- `OAuthButton` ships sensible inline default styles **only when no `className` is given**. Passing `className` removes all default styling (it's all-or-nothing), and built-in logo SVGs are included for `github`/`google`/`apple`.

### Layering app profile data over `useAuth`

`useAuth` is the source of truth for the session. For app-specific data (e.g. a `profile` row), wrap it in your own context rather than duplicating auth logic:

```tsx
import { useAuth as useSupatypeAuth } from "@supatype/react"

export function AuthProvider({ children }: { children: ReactNode }) {
  const { user, loading, signOut } = useSupatypeAuth()
  const userId = user?.id ?? null
  const [profile, setProfile] = useState<Profile | null>(null)

  useEffect(() => {
    if (!userId) { setProfile(null); return }
    void fetchProfile(userId).then(setProfile)
  }, [userId])

  // expose { userId, profile, loading, signOut, ... } via your own context
}
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

`$@supatype/client` pins the transitive copy to whatever version your app's direct dependency resolves to. Run `npm install` afterwards. (These packages are published as `0.1.0-alpha.*` prereleases, so version skew is common — pin deliberately.)

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
