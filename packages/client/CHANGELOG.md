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

### Bug Fixes

* **auth:** a request refused with 401 is sent again only when the server said the token was
  expired or invalid (`PGRST301`, `PGRST303`, or "JWT expired"), a session was there to refresh, and
  the refresh produced a different token. Every 401 used to be sent twice, an anon write a row rule
  refused among them. The refresh now runs even when the local clock still calls the token valid,
  since the server has said otherwise.
