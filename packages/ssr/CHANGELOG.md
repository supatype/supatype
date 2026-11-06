# Changelog

## Unreleased

### Features

* **next:** `@supatype/ssr/next` exports `GET` for `app/supatype-env.js/route.ts`. It answers
  `window.__SUPATYPE_ENV__ = {"url":"...","anonKey":"..."};` from `SUPATYPE_URL` and
  `SUPATYPE_ANON_KEY` as the running server has them, with the Supatype server's own body and headers
  (`application/javascript; charset=utf-8`, `Cache-Control: no-cache`, `X-Content-Type-Options:
  nosniff`). Switched off with `SUPATYPE_PUBLIC_ENV=false` (or `0`, `no`, `off`) it is 404
  `no-store`. Misconfigured it is 503 `no-store`, naming the setting to fix and never echoing a key:
  `SUPATYPE_ANON_KEY` or `SUPATYPE_URL` unset (a page given only the key would fail for want of an
  address), `SUPATYPE_PUBLIC_ENV` holding a word it cannot read (the body names the words it takes),
  or the anon key variable holding a service role token. No service role value is ever read.
  With `<Script src="/supatype-env.js" strategy="beforeInteractive" />`
  in the root layout, one `next build` runs against any deployment. The route file writes
  `export const dynamic = "force-dynamic"` itself, since Next's build does not recognize a
  re-exported segment config.
* **server-client:** `createServerClient(options)`, and `undefined` for either of `url` and
  `anonKey`, take them from `SUPATYPE_URL` and `SUPATYPE_ANON_KEY` in the server's environment,
  read when the client is created, and where one is unset from `NEXT_PUBLIC_SUPATYPE_URL` or
  `NEXT_PUBLIC_SUPATYPE_ANON_KEY`. `createServerClient(url, anonKey, options)` works as before.
