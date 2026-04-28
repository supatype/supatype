# @supatype/ssr

Server-side rendering utilities for Supatype. Creates a typed client from cookie-based auth context so Server Components, Route Handlers, and middleware can access the current user's session without any browser APIs.

## Installation

```bash
pnpm add @supatype/ssr
```

## Usage

### Next.js App Router

Create a server client factory that reads cookies on each request:

```ts
// lib/supatype-server.ts
import { createServerClient } from "@supatype/ssr"
import { cookies } from "next/headers"
import type { Database } from "@/types/database"

const url = process.env.NEXT_PUBLIC_SUPATYPE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPATYPE_ANON_KEY!

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() { return cookieStore.getAll() },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options ?? {})
          )
        } catch { /* no-op in read-only Server Component context */ }
      },
    },
  })
}
```

Use it in a Server Component:

```ts
// app/page.tsx
import { createClient } from "@/lib/supatype-server"

export default async function Page() {
  const supatype = await createClient()
  const { data: posts } = await supatype.from("posts").select().eq("status", "published")
  // ...
}
```

Access the session in a Server Component or Route Handler:

```ts
const supatype = await createClient()
const { data: { session } } = await supatype.auth.getSession()
// session is null if no valid cookie is present
```

### Cookie adapter interface

`createServerClient` accepts any framework's cookie store via the `CookieAdapter` interface:

```ts
interface CookieAdapter {
  getAll(): Array<{ name: string; value: string }>
  setAll(cookies: Array<{ name: string; value: string; options?: CookieOptions }>): void
}
```

### Cookie prefix

Auth tokens are stored under `sb-<project-ref>-auth-token` by default. If you've configured a custom prefix, pass it via `cookiePrefix`:

```ts
createServerClient(url, anonKey, {
  cookies: adapter,
  cookiePrefix: "myapp",
})
```

## How it works

1. Reads all cookies via the adapter's `getAll()`
2. Finds the auth token cookie matching `<prefix>-*-auth-token`
3. Parses the JSON session value and checks the JWT `exp` claim — expired tokens are discarded
4. Passes the session as `initialSession` to `createClient`, so all subsequent requests carry the user's JWT automatically
5. Signature verification is handled server-side by the gateway when the token is forwarded

## API

### `createServerClient<TDatabase>(url, anonKey, options)`

Returns a fully-typed `SupatypeClient` pre-loaded with the user's session from cookies. The returned client has the same API as the browser client — `.from()`, `.auth`, `.storage`, `.rpc()`, etc.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cookies` | `CookieAdapter` | required | Read/write cookie adapter |
| `cookiePrefix` | `string` | `"sb"` | Cookie name prefix |
