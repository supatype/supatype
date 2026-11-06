# Changelog

## Unreleased

### Breaking Changes

* **query:** `insert`, `update`, `upsert` and `delete` ask for no rows back and resolve to
  `data: null`, as postgrest-js does. Chain `.select()` (or `.select(columns)`) to get the written
  rows. Returning a row needs the right to read it, so a table whose rules let a caller create but
  not read (an anon order form, say) refused every insert with 401 `42501`. A plain `delete()`
  resolves to `null` rather than `[]`. On a model that keeps drafts, the drafts are read back only
  after `.select()`.
* **query:** `.single()` and `.maybeSingle()` on a write are a type error until `.select()` is
  chained. Called without it from untyped code, they answer an error and send nothing.
* **query:** `fetchWithOptional401Retry`'s `onUnauthorized` (and `GraphqlTransport.onUnauthorized`)
  is an `UnauthorizedHandler`: `(refusedToken: string) => Promise<boolean>`, answering whether the
  session now holds a different token. It was `() => Promise<void>`.
* **bindings:** `runMutation(client, table, operation, data, request)` takes one `MutationRequest`
  (`filter`, `publish`, `select`) in place of the positional `filter` and update options, and returns
  rows only when `request.select` asks for them (`true`, or the columns as `.select()` takes them).

### Features

* **client:** `createClient`'s `url` and `anonKey` are optional. One left out, or empty as a bundler
  leaves an unset name, is read from `window.__SUPATYPE_ENV__` when the first request is made. The
  page sets it with `<script src="/supatype-env.js">`, which a Supatype server answers, and which a
  Next.js app serves from the route `@supatype/ssr/next` exports, so one build works on every
  deployment that serves it. Read at the first request rather than at `createClient`, so a script
  that loads after the module creating the client still counts. A value given always wins, and no
  address is ever guessed from the page's own origin. `client.url` is the address as found so far,
  empty until there is one.
* **client:** `AuthClient`, `StorageClient`, `BucketClient`, `RealtimeClient`, `QueryBuilder` and
  `MutationBuilder` take their address (and `AuthClient` its headers) as a value or as a function
  read for each request. A plain string works as before.

### Bug Fixes

* **client:** the first request a client makes with no address or no anon key throws
  `MissingClientValuesError`, naming what is missing, every frontend name to set (`VITE_`, `PUBLIC_`,
  `NEXT_PUBLIC_`, `EXPO_PUBLIC_`), `supatype build`, the `/supatype-env.js` script tag, and for
  Next.js the route file `app/supatype-env.js/route.ts` and the server's `SUPATYPE_URL` and
  `SUPATYPE_ANON_KEY`. REST, rpc, auth, storage, functions, GraphQL and a realtime subscribe all
  throw it, and none turns it into `{ data: null, error }`. Requests used to go out with
  `apikey: undefined`, every one was refused, and a production build was a blank page with nothing
  saying why. `createClient` itself never throws for either value, so `next build` prerenders a page
  that creates a client at module scope without them. The check reads the page at run time, so a
  bundler that replaced both names with `undefined` cannot fold it away. On a server, where there
  is no page, the error names `SUPATYPE_URL` and `SUPATYPE_ANON_KEY` as the server's variables to
  set first, then the build-time names, rather than a `window.__SUPATYPE_ENV__` no server has.
  `MissingClientValuesError` is exported for an app to catch.

* **auth:** a request refused with 401 is sent again only when the server said the token was
  expired or invalid (`PGRST301`, `PGRST303`, or "JWT expired"), a session was there to refresh, and
  the refresh produced a different token. Every 401 used to be sent twice, an anon write a row rule
  refused among them. The refresh now runs even when the local clock still calls the token valid,
  since the server has said otherwise.
