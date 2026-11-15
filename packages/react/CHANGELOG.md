# Changelog

## 0.9.3

### Features

* **useChannel:** `useChannel(name, setup, deps)` joins one channel and hands it to `setup` to add any
  number of row, presence and broadcast listeners, which `useSubscription` (one row listener) cannot.
  It unsubscribes on unmount and when `name` or `deps` change, and returns `status`, `error`,
  `isConnected` and `connectionState`.
* **useRealtimeConnection:** `isConnected` and `connectionState` for the realtime socket itself.
* **useChannel:** takes `{ private: true }` as a fourth argument, passed to the channel join (see the
  client changelog). A refused or withdrawn private join is `CHANNEL_ERROR` with `error` a
  `RealtimeChannelError` whose `reason` says why.
* **useChannel:** returns `refusal`, the latest broadcast, presence track or payload the server refused
  on the channel (`{ channel, code, message }`, `code` one of `send_denied`, `track_denied`,
  `payload_refused`), or null. The channel stays joined: `status` does not change for it.

## Unreleased

### Breaking Changes

* **useMutation:** `mutate` returns no rows unless asked: `data` is `null` after an insert, update,
  upsert or delete, as with the client's own writes. Pass `{ select: true }` for every column or
  `{ select: "id,title" }` for some, as `.select()` takes them. Returning a row needs the right
  to read it, so a table whose rules let a caller create but not read refused every insert made
  through `useMutation`. A delete returns `null` rather than `[]`, and its rows with `select`.
  `filter` and `publish` keep their meaning.

### Features

* **useAuth:** `signInWithSSO({ domain })` or `signInWithSSO({ providerId })`, beside
  `signInWithOAuth`: the client's SAML sign-in, which sends the browser to the identity provider
  (unless `options.skipBrowserRedirect`) and returns its URL.

### Bug Fixes

* **useQuery, useMutation, useFunction, useAuth:** a request that throws instead of answering
  `{ data, error }` (a client with no API address or anon key throws from its first request) ends
  loading and becomes the hook's `error`, logged once with `console.error`. `useQuery` stayed on
  loading for good, with the rejection unhandled, and so did `useAuth` when starting the client
  threw. `mutate` and `invoke` now resolve with `{ data: null, error }` for a thrown request, as
  they do for a refused one, instead of rejecting. A returned `{ error }` is unchanged.
* **useQuery:** only the latest request is shown. When the options changed while a read was in
  flight, the older read could finish last and replace the newer rows with its own rows, its error
  or its throw. A throw from a replaced read is still logged.
