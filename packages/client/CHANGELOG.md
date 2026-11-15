# Changelog

## 0.9.3

### Breaking Changes

* **bindings:** `watchTable` (on `@supatype/client/bindings`) takes the client as its first argument, not
  `client.realtime`, because it now reads the table to seed its rows. The Vue, Solid and Svelte
  bindings are updated; anyone calling it directly must pass the client, as `watchTable(client, table,
  options, handlers)`.

### Features

* **client:** `client.anonKey`, beside `client.url`: the anon key as given, else as the page set it,
  read each time and an empty string while neither has one.
* **realtime:** `client.realtime.isConnected`, `client.realtime.connectionState` and
  `client.realtime.onConnectionChange(listener)`, which returns an unsubscribe function. The state is
  `"connected"`, `"connecting"` (first connect, a reconnect after a drop or a sign-in swap, or a wait
  before retrying) or `"disconnected"`. Channel statuses are unchanged. Exports
  `RealtimeConnectionState`, `RealtimeConnectionListener` and the `ChannelSubscription` type.

* **bindings:** `watchChannel`, `watchConnection` and `channelSlot` on `@supatype/client/bindings`, which the
  Vue, Solid and Svelte `useChannel` / `createChannel` share. `watchTable` takes the client, not its realtime
  client, so it can read the table: its rows are seeded by a read after each join and re-join and kept by
  upsert on a key (the `key` option, default `id`), so the Vue, Solid and Svelte `useSubscription` /
  `createSubscription` hold rows that existed before subscribing and recover from a drop.
* **realtime:** `channel(name, { private: true })` asserts that a channel is guarded by a schema
  `Channel` declaration. The join carries `private: true`. The server enforces declarations whether
  or not it is set; the option makes a name no declaration matches a refused join (a typo fails at
  once) and makes the client refuse to join at all when the server does not announce
  `private_channels` on its first frame, since an older server would ignore the flag and admit an
  open channel. A private join waits for that first frame before it is sent.
* **realtime:** `RealtimeChannelError` (a `RealtimeError`) is what a channel's status callback gets
  with `CHANNEL_ERROR` for any channel-scoped refusal. `reason` is `unsupported_server`,
  `join_denied`, `not_declared`, `does_not_fit`, `unavailable`, `shared_instance`, `withdrawn` or
  `refused`; `channel` names it and `retryable` is true for `unavailable`. It was a plain `Error`
  with the server's message, which `message` still carries. `isRealtimeChannelError(value)` tells one from any other error, across copies of the package.
* **realtime:** access the server takes away from a channel you hold (token change, periodic
  re-check, declaration removed) reaches every handle as `CHANNEL_ERROR` with reason `withdrawn`.
  It was swallowed for a handle with no row listener. The client does not rejoin by itself;
  subscribing again does.
* **realtime:** `ChannelOptions` is exported. A broadcast sent from the database with
  `_supatype.realtime_send` reaches `onBroadcast` listeners like any other; the README says so.
* **bindings:** `watchChannel` and `channelSlot` take `ChannelOptions` as a last argument, and a binding's
  `error` for a refused or withdrawn channel is the `RealtimeChannelError` itself, not a copy of its message.

### Bug Fixes

* **auth:** a restored session kept the user without `isAnonymous`, so a guest looked registered after
  every reload. The persisted user's camelCase keys, including those of `identities` and `factors`
  (`userId`, `identityData`, `factorType`, ...), are read back, and a user stored without the flag takes
  it from the token's `is_anonymous` claim.
* **realtime:** reconnect backoff is capped at 30 seconds. It doubled from one second for 10 attempts,
  reaching 512 seconds.

## Unreleased

### Breaking Changes

* **errors:** one error family. `SupatypeError` is a class, exported as a value and a type, and
  every error a result carries is one: `message` and, when known, `code`, `status`, `field`,
  `hint` and `details`, its JSON and spread exactly those fields. It replaces the `SupatypeError`
  interface. The SDK's thrown errors are its subclass `SupatypeCodedError` (the class that used to
  be called `SupatypeError`), keeping a required `code` and `helpUrl`: `AuthError`,
  `PostgrestError`, `StorageError`, `RealtimeError`, `NetworkError`, `RateLimitError` and now
  `MissingClientValuesError` (code `MISSING_CLIENT_VALUES`), so `instanceof SupatypeError` holds for
  all of them. Their `statusCode` is renamed `status`, the one name for it. `PostgrestError`'s
  `details` and `hint` are absent rather than `null` when the server gave none, and an rpc refusal
  is the `PostgrestError` itself. `AuthRedirectError` is a class too, with `provider` as one more
  own field. `SupatypeErrorFields` is the fields' type, as the constructor takes them.
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

* **auth:** `auth.signInWithSSO({ domain })` or `auth.signInWithSSO({ providerId })` signs in
  through a SAML identity provider registered on the project. It asks `POST /auth/v1/sso` for the
  identity provider's URL, returns it as `data.url`, and sends the browser there unless
  `options.skipBrowserRedirect` is set. `options` also takes `redirectTo`, `captchaToken` and
  `flowType`. SSO is PKCE by default, unlike `signInWithOAuth`: the S256 challenge goes with the
  request and the sign-in comes back as a `?code=` this browser exchanges, so no tokens are put in
  the URL; `flowType: "implicit"` opts out. A sign-in the identity provider starts comes back with
  tokens in the fragment, and the client signs in from them even while a PKCE sign-in it started is
  still waiting. A refusal (`sso_provider_not_found`, `sso_provider_disabled`) is the returned
  `SupatypeError`, and the page stays put. The argument's type is `SignInWithSSOCredentials`, and
  passing both a domain and a provider ID is a type error. A refusal the auth
  server sends back in the URL after an SSO sign-in is an `AuthRedirectError` whose `provider` is
  the exported `SSO_PROVIDER` (`"sso"`).
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

* **client:** `MissingClientValuesError` gives the script tag as
  `<script src="/supatype-env.js" vite-ignore></script>`, the form `vite build` leaves alone. The
  tag it gave made every `vite build` warn that it could not bundle the script.
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
* **client:** a page whose `/supatype-env.js` gave it no values is told why on its first call. A
  misconfigured server now answers the script 200 with `window.__SUPATYPE_ENV__ = {"error":"..."}`,
  since a browser runs no script answered with an error status and tells the page nothing of why,
  and every first call (table reads and writes, rpc, functions, GraphQL, auth, realtime and storage)
  throws `MissingClientValuesError` quoting that reason, with no request of its own. A page that has
  the script element but no `window.__SUPATYPE_ENV__` at all is no longer told to add the tag: the
  error says the script did not run (blocked, failed to load, ran after the app's own script, or
  from a server too old to serve it) and to open it in the browser. A page with no element is told
  to add it, as before.

* **auth:** a request refused with 401 is sent again only when the server said the token was
  expired or invalid (`PGRST301`, `PGRST303`, or "JWT expired"), a session was there to refresh, and
  the refresh produced a different token. Every 401 used to be sent twice, an anon write a row rule
  refused among them. The refresh now runs even when the local clock still calls the token valid,
  since the server has said otherwise.
* **bindings:** `reportThrown(where, thrown)` turns a request that threw instead of answering
  `{ data, error }` into the binding's `error`, and logs it once with `console.error`. A thrown
  `Error` is kept as it is, so `instanceof` still names it; the SDK's own error classes get the shape
  a failed request answers with. Every framework binding uses it, so none can leave `loading` set
  for good when a request throws.
* **bindings:** `latestRowsReader(client, table, where, view)` is the read the Vue, Svelte and
  Solid queries share, where only the newest request may change what the binding shows. An older
  read that lands last is dropped, rows, returned error or throw alike; a throw is still logged.
* **client:** the `error` of every `{ data, error }` result is now an `Error`, a `SupatypeError`,
  rather than a plain object. A network failure used to resolve `{ message: "fetch failed", code }`,
  so `error instanceof Error` was false and `String(error)` printed "[object Object]", which is what
  a page rendering the error showed for an unreachable server or a CORS refusal. It is now the
  `NetworkError` the transport threw, reading `NetworkError: fetch failed` with a stack. Its JSON is
  the same `message`, `code`, `status`, `field`, `hint` and `details` as before; a test comparing
  the error with `toEqual` against a plain object needs `{ ...error }`, since Vitest tells an Error
  from one. Server refusals, client-side refusals (`Not authenticated`) and `reportThrown` follow
  suit: `reportThrown` keeps an SDK error as it is and holds any other thrown value as the `cause`
  of a `SupatypeError`.
