# Changelog

## Unreleased

### Breaking Changes

* **useMutation:** `mutate` returns no rows unless asked: `data` is `null` after an insert, update,
  upsert or delete, as with the client's own writes. Pass `{ select: true }` for every column or
  `{ select: "id,title" }` for some, as `.select()` takes them. Returning a row needs the right
  to read it, so a table whose rules let a caller create but not read refused every insert made
  through `useMutation`. A delete returns `null` rather than `[]`, and its rows with `select`.
