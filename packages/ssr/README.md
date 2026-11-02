# @supatype/ssr

Server-side rendering utilities for Supatype. Creates a typed client from cookie-based auth context so Server Components, Route Handlers, and middleware can access the current user's session without any browser APIs.

## Installation

```bash
pnpm add @supatype/ssr
```

## Usage

### Next.js App Router

Create server client factories that read cookies on each request: one for Server Components, which
cannot write cookies, and one for Route Handlers and Server Actions, which can:

```ts
// lib/supatype-server.ts
import { createServerClient } from "@supatype/ssr"
import { cookies } from "next/headers"
import type { Database } from "@/types/database"

const url = process.env.NEXT_PUBLIC_SUPATYPE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPATYPE_ANON_KEY!

// Server Components: no `setAll`, so the client never refreshes the session.
export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() { return cookieStore.getAll() },
    },
  })
}

// Route Handlers and Server Actions: a refreshed session goes back to the browser.
export async function createWritableClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() { return cookieStore.getAll() },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) =>
          cookieStore.set(name, value, options ?? {})
        )
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
// session is null if no valid cookie is present. Without `setAll` it is the cookie's session as it
// is: its access token may have expired, since that client never refreshes it.
```

### Cookie adapter interface

`createServerClient` accepts any framework's cookie store via the `CookieAdapter` interface:

```ts
interface CookieAdapter {
  getAll(): Array<{ name: string; value: string }>
  setAll?(cookies: Array<{ name: string; value: string; options?: CookieOptions }>): void
}
```

`setAll` is called whenever the session changes on the server: a refreshed access token, a sign-in
or a sign-out. It receives the session cookie (`<prefix>-auth-token`) in the format the browser
client writes, with `path: "/"`, `sameSite: "lax"` and a `maxAge` that ends with the access token;
a sign-out or a refused refresh sends an empty value with `maxAge: 0`. The value is not encoded:
pass it to your framework's cookie setter, which encodes it as it does any cookie. Add `secure` or
`httpOnly` in the adapter if you want them.

Leave `setAll` out where cookies are read-only, such as a Server Component. Without it the client
never refreshes the session: an expired access token is sent as it is, and the API refuses it. A
refresh spends the refresh token the browser holds and returns a new one, and a client that cannot
write cookies would keep that new one to itself, so the browser's own next refresh would be refused
and sign it out. Do not pass a `setAll` that swallows the failure there instead: the client then
refreshes as if the write had worked. Refresh in middleware, which can write cookies, before the
page renders, so a Server Component reads a session that is still valid.

### Cookie prefix

The browser client stores the session under `st-auth-token` by default. If you've configured a custom prefix (`auth.cookiePrefix` on `createClient`), pass the same one via `cookiePrefix`:

```ts
createServerClient(url, anonKey, {
  cookies: adapter,
  cookiePrefix: "myapp",
})
```

## How it works

1. Reads all cookies via the adapter's `getAll()`
2. Finds the auth token cookie `<prefix>-auth-token`, or one matching `<prefix>-*-auth-token`
3. Parses the JSON session value and checks the JWT `exp` claim. A session whose access token has expired is kept only when it has a refresh token
4. Passes the session as `initialSession` to `createClient`, so all subsequent requests carry the user's JWT automatically. The client keeps no session of its own and runs no refresh timer. With `setAll`, an expired access token is refreshed only when a request the client makes finds it expired; without `setAll`, it is never refreshed and is sent as it is. Parsing uses `atob` and `TextDecoder`, not Node's `Buffer`, so it works on edge runtimes
5. Writes every change to the session (a refresh, a sign-in, a sign-out) back through the adapter's `setAll`, so the browser holds the new tokens
6. Signature verification is handled server-side by the gateway when the token is forwarded

## API

### `createServerClient<TDatabase>(url, anonKey, options)`

Returns a fully-typed `SupatypeClient` pre-loaded with the user's session from cookies. The returned client has the same API as the browser client, `.from()`, `.auth`, `.storage`, `.rpc()`, etc.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cookies` | `CookieAdapter` | required | `getAll()` reads the request's cookies; optional `setAll()` writes the session cookie when the session changes, and without it the client never refreshes the session |
| `cookiePrefix` | `string` | `"st"` | Cookie name prefix: the session cookie is `<prefix>-auth-token` |
