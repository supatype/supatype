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
// lib/supatype-server.ts, in the folder that holds app/ (the project root, or src/ when the app is
// in src/app), where create-next-app's `@/*` alias points.
import { createServerClient } from "@supatype/ssr"
import { cookies } from "next/headers"
import { connection } from "next/server"
import type { Database } from "@/types/database"

// The address and anon key come from SUPATYPE_URL and SUPATYPE_ANON_KEY in the server's
// environment, read on each call, so the same build runs against whichever deployment it is
// started for. Pass them first, as createServerClient(url, anonKey, options), to use others.

// Server Components: no `setAll`, so the client never refreshes the session. `connection()` renders
// the component at request time: the client reads the clock to check the session's expiry, which
// Next 16 with `cacheComponents` logs as an error while prerendering. It is in Next 15 and later;
// on Next 14 leave it out.
export async function createClient() {
  const cookieStore = await cookies()
  await connection()
  return createServerClient<Database>({
    cookies: {
      getAll() { return cookieStore.getAll() },
    },
  })
}

// Route Handlers and Server Actions: a refreshed session goes back to the browser.
export async function createWritableClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>({
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

### The browser client's values at run time (`@supatype/ssr/next`)

`next build` prerenders static pages without the deployment's values. Serve them to the page when
it loads instead, from the same two server variables, with a route and one line in the root layout:

```ts
// app/supatype-env.js/route.ts
export { GET } from "@supatype/ssr/next"
```

```tsx
// app/layout.tsx
import Script from "next/script"

// inside <body>, before anything else:
<Script src="/supatype-env.js" strategy="beforeInteractive" />
```

The route needs no segment config, and must not export `dynamic`: Next 16 with `cacheComponents`
on, as a new create-next-app has it, refuses that with a 500. `GET` reads the request, which makes
Next 14 and Next 16 with `cacheComponents` render it per request rather than prerender it with the
build machine's values; Next 15, and Next 16 without `cacheComponents`, render every `GET` per
request anyway. A route written by `supatype init` 0.9.1 has `export const dynamic = "force-dynamic"`;
`supatype generate` (run by the project's `prepare` on install) replaces it while it is still as
init wrote it, and warns about one changed since. Otherwise delete that line. `GET` answers
`window.__SUPATYPE_ENV__ = {"url":"...","anonKey":"..."};` from `SUPATYPE_URL` and
`SUPATYPE_ANON_KEY` as the server has them on each request, with `Cache-Control: no-cache`, the same
body and headers the Supatype server gives its own `/supatype-env.js`. Switched off with
`SUPATYPE_PUBLIC_ENV=false` it answers 404 `no-store`. Misconfigured it still answers 200, with
`Cache-Control: no-store` and `window.__SUPATYPE_ENV__ = {"error":"..."};`, since a browser runs no
script answered with an error status and tells the page nothing of why. The browser client throws
that reason on its first call. It names every setting to fix, one line each and the key's first:
`SUPATYPE_ANON_KEY` or `SUPATYPE_URL` unset (both named when both are), `SUPATYPE_PUBLIC_ENV` set to
a word other than true/1/yes/on or false/0/no/off (blank counts as on), or the anon key variable
holding a service role token. No key is echoed, and no service role value is ever read.

The browser client, created with no `url` or `anonKey` (or with `NEXT_PUBLIC_` names left unset at
build time), reads `window.__SUPATYPE_ENV__` at its first request. A client created at module scope
does not throw while the build prerenders a page; its first request throws, naming what to set,
when neither the build nor the page supplied the values.

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

### `createServerClient<TDatabase>(url, anonKey, options)`, or `createServerClient<TDatabase>(options)`

`url` and `anonKey` default to `SUPATYPE_URL` and `SUPATYPE_ANON_KEY` from the server's environment
when left out, `undefined` or empty, and where one of those is unset to `NEXT_PUBLIC_SUPATYPE_URL` or
`NEXT_PUBLIC_SUPATYPE_ANON_KEY`. Returns a fully-typed `SupatypeClient` pre-loaded with the user's session from cookies. The returned client has the same API as the browser client, `.from()`, `.auth`, `.storage`, `.rpc()`, etc.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cookies` | `CookieAdapter` | required | `getAll()` reads the request's cookies; optional `setAll()` writes the session cookie when the session changes, and without it the client never refreshes the session |
| `cookiePrefix` | `string` | `"st"` | Cookie name prefix: the session cookie is `<prefix>-auth-token` |
