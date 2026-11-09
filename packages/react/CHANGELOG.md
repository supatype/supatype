# Changelog

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
