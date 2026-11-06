# Changelog

## Unreleased

### Breaking Changes

* **useMutation:** `mutate` returns no rows unless asked: `data` is `null` after an insert, update,
  upsert or delete, as with the client's own writes. Pass `{ select: true }` for every column or
  `{ select: "id,title" }` for some, as `.select()` takes them. Returning a row needs the right
  to read it, so a table whose rules let a caller create but not read refused every insert made
  through `useMutation`. A delete returns `null` rather than `[]`, and its rows with `select`.

### Bug Fixes

* **useQuery, useMutation, useFunction, useAuth:** a request that throws instead of answering
  `{ data, error }` (a client with no API address or anon key throws from its first request) is
  logged once with `console.error` and held as `error` as it was thrown, so `instanceof` still
  names it. `useQuery` and `useMutation` kept only its message and said nothing; `useAuth` dropped
  it and showed no error; `useFunction` rejected and left `error` empty. `invoke` now resolves with
  `{ data: null, error }` for a thrown request, as it does for a refused one. A returned `{ error }`
  is unchanged.
* **useAuth:** a component unmounted while the client was still starting left its auth listener
  subscribed for the life of the client, since it subscribed only after start-up. It now subscribes
  first, so unmounting removes it.
* **useQuery:** only the newest read is shown. A refetch while a read was in flight let the older
  read finish last and replace the newer rows with its own rows, its error or its throw, and end
  loading while the newer read was still out. A throw from a replaced read is still logged.
