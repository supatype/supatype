# Changelog

## Unreleased

### Features

* **seed:** a seed file now exports a default function and describes writes rather than
  performing them. The calls are collected into a document that the engine validates against
  the schema, orders by foreign key, batches, and applies in one transaction. There is no
  connection to open, no SQL, no ordering to work out by hand, and a failure part way through
  leaves nothing behind. See `references/seeding.md`.
* **seed:** `db` is typed from the project's schema by a generated builder. A reference to the
  wrong model, a `where` on a column that does not identify a row, a time expression on a text
  column, or a currency amount as a float are all compile errors.
* **seed:** `upsert`, `createMany`, nested `create` on the inverse side of a relation, and
  `connect` by any unique key.
* **seed:** `$if` runs a block only when the database says so, evaluated by the engine at that
  position inside the transaction. `$sql` puts a raw statement in the same transaction and the
  same order as everything else.
* **seed:** `expr.now`, `expr.startOf`, `expr.ago` and `expr.default` are evaluated by Postgres
  at seed time, so a fixture calendar stays ahead of whenever it is run.
* **seed:** `--status` reports what has been applied to an environment, including whether a file
  has changed since it ran. `--atomic` runs every file in one transaction. `--connection` and
  `--environment` were added alongside.
* **seed:** every run is recorded in `_supatype.seeds`, inside the same transaction as the writes
  it describes, so the record can never claim a seed applied when it rolled back. A file may opt
  into `runOnce` for a genuine one-time backfill.
* **seed:** failures arrive in the schema's terms. `Organiser.slug is already taken`, with the
  file and the position in the document, rather than a Postgres constraint name.
* **seed:** exit codes distinguish a seed that failed (1) from an environment that is not set up
  (2), so CI can tell which one to retry.
* **seed:** the connection string is resolved from the flag, the config, the environment and the
  project's `.env` in that order, and when none of them has one the error names every source it
  tried. Connection strings are redacted wherever they are printed.
* **generate:** writes the seed builder beside the generated client. It needs no database and no
  running stack, which is what makes it safe to gitignore.
* **init:** the scaffolded seed uses the new contract and carries no connection string. The
  scaffolded `package.json` runs `supatype seed` and gains a `prepare` script so a fresh clone
  has a builder before anything imports it.
* **dev:** the database is always published to the host on `127.0.0.1`. Seeding is a host
  process, so the previous rule left a fresh project with a database nothing on the host could
  reach and a remedy nobody had reason to know about.
* **schema:** `After<>` and `Before<>` are parsed from the schema into the AST.

* **generate:** a rich text column is typed as the document it holds on the way out and as
  `RichText | string` on the way in. The engine emits a trigger that normalises a plain string
  into a Lexical document on insert and update, so prose can be written as prose while a read
  always returns the document. The seed builder gets the same split, and a tightening with it:
  the column was typed as any JSON at all, so a seed could write a bare number into one.

### Bug Fixes

* **generate:** the client augmentation follows the order the schema declares its models and
  columns in. It sorted alphabetically, which threw away an order the author chose and the AST
  preserved, and made it disagree with `types/database.ts` about the same table.
* **generate:** a `Slug` column is no longer demanded on insert. A trigger fills it, so the
  generated type was asking for a value the database was about to overwrite.
* **generate:** a rich text column is typed as the Lexical document it holds. It was
  `SerializedEditorState | string`, which made the augmentation disagree with
  `types/database.ts` about the same column in the same project.
* **generate:** the augmentation's columns are indented into the block that holds them.
* **generate:** the augmentation and the database types use the same named types for storage
  references and rich text, rather than one naming them and the other writing them out.
* **hooks:** the generated Deno stand-in for rich text loses its `| string` for the same reason,
  and a storage reference is declared beside it.
* **generate:** the generated output paths are resolved in one place. `generate` applied defaults
  and the seed runner did not, so a project that had configured no output got a builder written
  and then a run that reported it missing.
* **engine:** a failed seed is reported with its result document. The engine exits non-zero and
  prints what happened, and that was being discarded as a crash with no output.
