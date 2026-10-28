# Changelog

## Unreleased

### Breaking Changes

* **schema:** a `?` on a model field (`due?: string`) is refused, naming `Model.field` and saying to
  write `Optional<>`. It read as nullable but compiled to a `NOT NULL` column.
* **generate:** `supatype generate --connection` is refused as an unknown option. Generate writes the
  types from the schema file and never opened a database, so the option was accepted and ignored.
* **seed:** a seed file's `export const config = { transaction: ... }` is refused, and `transaction`
  is gone from `SeedConfig`. It was validated and never sent: every seed file runs in a transaction
  of its own (all of them in one with `--atomic`), and the engine cannot run one outside it. Any
  other key `config` does not have (a misspelt `runonce`, say) is refused too, rather than ignored.

### Features

* **init:** `supatype init <dir> --example <name>` starts from `examples/<name>` of the release
  matching the CLI (`v<version>` on GitHub), with every `workspace:` dependency pinned to
  `^<version>`. An unknown name is refused with the list of examples in that release, and so is an
  example holding a file named with `..`, a backslash, a NUL, a leading drive (`C:`) or an absolute
  path, or one that resolves outside the directory; nothing is written then. A colon anywhere in a
  name is refused too, since on Windows `docs/a:b.md` writes a hidden stream of a file `docs/a`.
  Such a name elsewhere in the repository does not stop an example.
* **seed:** `authUser: { connect: { id } }` on a relation to the auth user (`RelatedTo<SupatypeAuthUser>`)
  writes the relation's key column. It failed with "`supatype:user` is not a model in this schema".
  The generated `...Create` type still offers the key column (`auth_user_id`) rather than `authUser`;
  that comes from the engine.
* **schema:** `Geo<"polygon">` and `Geo<"linestring">` compile to `GEOGRAPHY(POLYGON, 4326)` and
  `GEOGRAPHY(LINESTRING, 4326)`. Every `Geo` field was a point whatever it said; a bare `Geo` still is.
* **keys:** `supatype keys` writes into `.env` when there is one, filling only the blank keys, as
  `--write` did. `--print` only prints. `--write` still works, so scripts and docs written for 0.7.0
  keep running. With no `.env` the keys are printed, with a line saying how to have them written.
  `--print` with no secret anywhere exits 1 rather than printing keys signed with one it made up and
  kept nowhere. `--print` checks the secret as writing does, since printed keys end up in a `.env`
  all the same: at least 32 characters, and for a given one, no whitespace, `#` or quotes.
* **keys, self-host, init, dev:** one rule for the `JWT_SECRET` keys are signed with. `.env`'s always
  wins. A shell `JWT_SECRET` is used only when `.env` has none, and is then written into `.env`; one
  that differs from `.env`'s gets a single warning line saying `.env`'s is used, and is never
  refused. Only a `keys --secret` that differs from `.env`'s is refused. Docker Compose reads the
  shell ahead of `.env`, so every compose command now runs without the shell's `JWT_SECRET`,
  `ANON_KEY` and `SERVICE_ROLE_KEY` when `.env` defines that name, and without a shell key the stack
  would not accept under `.env`'s `JWT_SECRET` (another secret, another role, or expired):
  `supatype dev` on docker with a different shell `JWT_SECRET` started services that refused every
  key with 401. A shell key the stack accepts still fills a blank one. `push`, `status` and the
  other commands calling the local stack follow the same rule, and send `.env`'s `SERVICE_ROLE_KEY`,
  the name the stack is started with, and never a `SUPATYPE_SERVICE_ROLE_KEY` there. When a
  `JWT_SECRET` is newly written into `.env` (given or generated), `keys` and `self-host compose up`
  sign both keys again and say so, since keys already there cannot verify against it. A secret is
  checked before anything is written: at least 32 characters, and for one written into `.env`, no
  whitespace, `#` or quotes. `compose up` used to write keys signed with a short secret and then
  refuse it, leaving keys that were never re-signed once the secret was fixed. `init` warns and
  generates a secret when the shell's is unusable, and never exits mid-wizard over the keys.
* **keys, dev:** `NEXT_PUBLIC_SUPATYPE_ANON_KEY` is written beside the `VITE_`, `PUBLIC_` and
  `EXPO_PUBLIC_` copies, and `NEXT_PUBLIC_SUPATYPE_URL` wherever the other URL copies are.

### Bug Fixes

* **migrate:** restoring a migration's schema sources refuses a file that lands beside the project
  under a path starting with the project's own (`/srv/app2/x.ts` for `/srv/app`). The check compared
  string prefixes, so it took that file for one inside the project. The snapshot is now read by the
  same tar reader as `init --example`, so a name with a backslash, a NUL, a leading drive or an
  absolute path is refused too (a backslash was read as a separator), an entry naming the project
  root itself (`./`) is refused rather than failing on write, and a name that only starts with two
  dots (`..notes/x.ts`) is restored rather than refused. The backup taken before a restore copies
  the files the snapshot overwrites, not the paths its manifest lists, which were never checked.

* **schema:** an `id: SupatypeAuthUserId` primary key under `create: Owner<"id">` (also inside `Any`
  or `All`) no longer gets a `gen_random_uuid()` default. A random id names no user, and the default
  kept the engine from defaulting the column to the caller, so an insert leaving `id` out was
  refused. Under any other create rule the key keeps its random default, as nothing else fills it.
  The generated `Insert` type leaves `id` optional either way, since the database fills it.
* **self-host:** `self-host native backup`, `serve`, `reload`, `status`, `logs` and `install-service`
  run their own action with their own options. They were declared as executable subcommands, so
  their options and actions landed on `self-host native` and `self-host`.
* **seed:** a seed file in a project without `"type": "module"` (a Next.js app) can import
  `@supatype/cli/seed`. The export map had only an `import` condition, and a CommonJS seed failed
  with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
* **seed:** a failure whose message already carries its remedy (a column the database does not have)
  prints the remedy once, not twice.
* **init:** a new project depends on `@supatype/client`, pinned like the other packages; the
  generated `supatype/generated/client.ts` imports it.
* **init:** the wizard does not ask the project name `init <name>` already gave, does not ask for
  production storage when production is decided later, and shows a yes/no prompt's default as `Y/n`
  or `y/N`. `init --mode standalone` leads its next steps with the self-host steps, then local
  development.
* **app:** `supatype app add` and `app remove` rewrite `supatype.config.ts` at its own indentation and
  keep it valid TypeScript (they wrote `mode: "proxy",,` against init's config, and a comma in a
  comment after the last entry was taken for its separator), and the same for the `server` block
  `supatype add domain` writes. In a dev project they say to restart `supatype dev`, which keeps
  serving the old app until it restarts; in a self-hosted one, to run `self-host compose up -d`, which
  renders the compose file itself.
* **dev:** "Create an admin user now?" is asked once per project. A "no" is kept in
  `.supatype/admin-prompt.json`, so later starts neither ask nor wait; a run that is not interactive
  was never asked.
* **security:** a project with no `JWT_SECRET` gets one in `.env` from `dev` or `keys`: the shell's
  when usable, else a generated one. Before, it signed with a published fallback, and the docker dev
  path wrote that fallback into the `.env` a self-host deployment reads. A secret already in `.env`
  is kept, whatever it is. A native dev project that never had one signs with the new secret, so its
  existing sessions sign out once.
* **push:** on a native dev stack, the service-role key push uses to create storage buckets is the
  project's, from `.env`, as on docker. It was signed with the published dev secret, which a stack
  running with its own `JWT_SECRET` refused with 401.
* **env:** `.env` is read the way Docker Compose reads it, through one parser: `KEY=x  # note` is
  `x`, a quoted value keeps its `#`, `export KEY=` is understood, and the last assignment of a key
  wins. The CLI kept ` # note` in the value and read the first of two assignments, so it could sign
  keys with a secret, or wait on a port, that the stack did not have (F14:
  `SUPATYPE_DEV_DB_PORT` appended a second time was ignored). Updating a key assigned twice leaves
  one line for it.
* **dev, self-host:** database passwords are encoded in every connection URL the CLI builds. The
  compose file cannot encode them, so the commands that start or recreate containers (`dev` at
  startup, and `self-host compose up`, `render` and `restart`) refuse a `POSTGRES_PASSWORD`,
  `AUTHENTICATOR_PASSWORD` or `SUPATYPE_SQL_EDITOR_PASSWORD` holding a character that breaks a URL,
  naming the variable and how to generate a safe one. Writing the compose file does not check, so
  `update` and the dev watcher never exit over a password an older stack runs with. `push`, `diff`
  and dev's database recovery, which start only the database, print the same message as a warning.
  `self-host compose down`, `status` and `logs` run against the compose file already on disk rather
  than rewriting it from the current config, so such a stack can still be stopped and inspected.
  With no compose file on disk yet they render one, without the check.
* **self-host:** `self-host compose logs --service <name>` shows that service. The option was
  taken by the hidden native `logs` command, declared in a way that attached its options to
  `self-host` itself, so every service was shown. The other native commands had the same fault.
* **dev, self-host:** `compose up` failing with "all predefined address pools have been fully
  subnetted" says Docker is out of network addresses, how many Supatype networks there are, and that
  `docker network prune` frees the unused ones.
* **cli:** running the CLI from a monorepo checkout that has not been built says to run
  `pnpm install && pnpm build` at the repository root, rather than a bare "Cannot find module".


## 0.7.0

Highlights: `adopt` takes what a push refuses, with `--key`, `--release` and `--reclaim`, and
declares adopted columns in the schema; push asks before restoring access changed outside Supatype,
offers to declare a rename before dropping data, and records an audit trail; `doctor --rebaseline`
and doctor's drift view; `auth.providers` and `api.corsOrigins` in `supatype.config.ts`;
`SUPATYPE_PROJECT_NAME` and `--project-name`; the engine's LICENSE saved beside a downloaded engine;
every host connection uses one resolver; dev stops when the process that started it exits. For
self-host, the gateway decides CORS, compose mounts use absolute paths, and
`self-host compose restart` recreates one service. Upgrading from 0.3.x: read `UPGRADING.md`.

### Breaking Changes

* **schema:** `AutoIncrement<T>` compiles to an identity column generated by default
  (`GENERATED BY DEFAULT AS IDENTITY`, `Identity<T, "by-default">`) rather than `SERIAL`, marked
  `autoIncrement: true` in the AST. A serial column made when it compiled to one satisfies it: every
  push leaves it exactly as it is, with no change and no warning. An explicit `Identity<...>` on a
  serial column converts it.
* **security:** `supatype dev` no longer writes `STUDIO_OPEN_DEV` into the compose file, and the
  server no longer reads it. With it set, the server's Studio proxy admitted unauthenticated
  requests as the service role, and dev allows every CORS origin, so any web page open in the
  developer's browser could read and write the whole database through it. Studio itself never used
  it: it always asked for a sign-in. Nothing changes for Studio in dev; scripts that called
  `/studio/proxy` without a session must sign in or use the service role key directly.

### Features

* **schema:** identity and stored generated columns. The schema compiler reads the options form
  (`Int<{ identity: "always" }>`, `Float<{ generated: "price * qty" }>`) and the aliases
  (`Identity<>`, `Generated<>`, `AutoIncrement<>`) into one AST encoding (`identity: "always" |
  "byDefault"`, `generated: { expression, stored: true }`), refusing an identity on a non-integer,
  both at once, or either with a default. The generated client types make a generated column and an
  identity `always` column `?: never` on insert and update; an identity `by-default` column is
  optional on insert. `Generated<T, "<sql>">` is the supported form for a generated column, on every
  type; there is no per-type options form to use instead.
* **push, diff, doctor, adopt, dev, deploy:** a schema with identity or generated columns is sent only
  to an engine that lists `identity_columns` in its capabilities (a linked target's
  `GET <schema base>/capabilities`, the engine binary's `capabilities`, the compose engine's). Any
  other is refused before anything is sent, naming the fields: update the engine, or declare them as
  plain columns and make the change in the database yourself. An older engine would have dropped
  them and pushed plain columns. A push also still refuses them on an engine pinned before 0.7.0.
* **push:** taking a column's identity away, or its generation expression, is destructive like a
  drop: the push lists it and asks first (`--yes` to agree without a prompt), and the engine refuses
  it without `--force`.
* **adopt, pull:** an identity or generated column is declared as one, from what the engine's
  introspection now says (`Identity<number>`, `Identity<bigint, "by-default">`,
  `SmallInt<{ identity: … }>`, `Generated<T, "<expression>">`), and a serial column as
  `AutoIncrement<number | bigint>`, when the engine lists `identity_columns`; otherwise such a column
  is printed to declare by hand, and a serial is declared as `ServerDefault<Int>` as before. `adopt` used to leave every NOT NULL
  integer with no default to be declared by hand, since it could not tell an identity column from an
  ordinary one, and declared a generated column as a plain one.
* **adopt:** adopts only what was agreed to. After a preview and a yes at the prompt, it adopts the
  conflicts the preview listed and nothing the database grew since; `--key kind:table.name`
  (repeatable, engine 0.7.0+) adopts only the objects named; `--yes` alone adopts every conflict
  there is and lists what it took. If an object it was to adopt is no longer a conflict, nothing is
  written and it exits 1: "The database changed since the preview; run `supatype adopt` again."
  The adopt offered by `push` and `dev` likewise takes only what it showed.
* **adopt:** adopting a column declares it. `supatype adopt --key column:<table>.<name>` hands
  Supatype a column added outside the schema, and the CLI then adds the field to the model whose
  table it is (found by its table name, `tableName` included, in any schema file) and runs what
  `supatype generate` does, so the next `supatype push` treats it as an ordinary declared field.
  The field key is the column name and its type is one whose column is exactly the live one
  (`Optional<…>` when nullable, `ServerDefault<…>` when the column has a default), so the push
  changes nothing; the edit keeps the file's formatting and comments and is checked by reading the
  schema back, or undone (only when the file is still exactly what was written). In a terminal it
  shows the file, model and field line and asks first;
  `--yes` edits without asking. When the model cannot be found, the type cannot be declared
  exactly, or the edit is declined, the file is left alone and the field line to add, with the file
  and model, is printed; the adopt has still happened and it exits 0. Other adopted kinds are not
  fields and are unchanged.
* **adopt:** an empty key list (adopt nothing, only release) reaches the engine binary as
  `--adopt-none`, in one call, instead of a second preview first.

### Bug Fixes

* **schema:** `Blocks<PageBlock>`, where `PageBlock` is an alias naming a union of blocks
  (`type PageBlock = HeroBlock | ProseBlock`), declared no blocks at all: the compiler only knew a
  `Block<...>` written in place or an alias of one, and dropped anything else. Studio then offered
  no block to add and both generated files typed the field as untyped entries. Aliases of unions are
  followed now, and a member that is not a `Block` is refused with its name rather than dropped.
* **schema:** an array inside a block (`Block<"stats", { counts: Int[] }>`) was sent without its
  element type, so the engine refused the whole schema (``missing field `elementType` ``) and the
  client augmentation typed every such array `string[]`. It carries the element type now, and both
  generators type it by element (`number[]`, `boolean[]`).
* **security:** a `supatype dev` lock left behind by a dev that was killed made every later compose
  render dev. A lock now records its process and counts only while that process is alive; a stale
  one is removed.
* **config:** `api.corsOrigins` names the browser origins a standalone server allows besides the
  site URL. It reaches the server ahead of `SUPATYPE_CORS_ALLOW_ORIGINS` from `.env`, and an entry
  that is not an origin or `*` is refused when the config is read.
* **security:** `supatype push` (and `diff`, `adopt`, `update`) against a stack started with
  `self-host compose up` rendered it as a dev stack and recreated it that way: every origin allowed
  by CORS, the Studio proxy answering unauthenticated requests as the service role
  (`STUDIO_OPEN_DEV=1`, since removed; see Breaking Changes), the database moved to a loopback dev
  port, and dev values written over the operator's `.env` (`SITE_URL`,
  `SUPATYPE_MAILER_AUTOCONFIRM=true`, a dev `DATABASE_URL`). Every command that renders the compose
  file now uses one rule for its mode: dev while a `supatype dev` session holds the project, else the
  mode the running server is in, else standalone. The same rule keeps a `supatype dev` stack dev
  through `self-host compose restart` and `up`, which used to recreate it as standalone.
* **push:** a push to the project's compose stack, or to a linked self-host server, waits (at most
  40 s, one line while it does) until REST stops answering 503. PostgREST 14 refuses to serve until
  the schemas it exposes exist, so a fresh stack answers `PGRST002` until the first push, and after
  the push PostgREST can take about 30 s to retry; the push used to report success while REST still
  refused. `supatype dev` is unchanged: it pushes before PostgREST starts.
* **self-host:** the generated compose file names every bind mount by absolute host path and names
  its compose project. Its paths were relative to the project root, which only `--project-directory`
  makes them; a hand-run `docker compose -f .supatype/self-host/docker-compose.yml` resolved them
  against that folder instead, so the server lost its admin config, manifest, API config, functions
  and hooks (Studio said no schema had been pushed) and Docker left an empty
  `.supatype/self-host/.supatype` behind. New `supatype self-host compose restart <service>`
  recreates one service with the current config and `.env`, so there is no reason to type compose.
* **migrate:** `supatype migrate` writes the SQL a push would apply (to stdout, or `-o <file>`)
  instead of calling a history endpoint that applied nothing. Plain, the engine plans it without
  taking any lock an application waits on and the file records nothing, which its header says;
  `--record` has the engine rehearse the push so the file records the history and the ledger as a
  push does, taking a push's table locks while it runs. `--force` allows destructive changes and
  rewrites of large tables.
* **push, dev:** a change the engine refuses because it rewrites a large table (IN-C 3) goes
  through the same consent as a destructive one: a terminal is asked whether to lock the table
  while it is rewritten, `push --yes` applies it, and anywhere else it is refused with the command
  that applies it on purpose.
* **doctor:** the rebaseline consent is renamed: `supatype doctor --rebaseline --accept-access-drift`
  records policies, grants, labels and RLS changed outside Supatype as the baseline too (sent as
  `accept_access_drift`, or `--accept-access-drift` to the engine binary). `--overwrite-drift` is
  push's flag, which puts Supatype's definitions back, the opposite; on `doctor` it is now an error
  that names the new flag. What the engine would not rebaseline without it is listed as "Not
  rebaselined".
* **push, adopt, doctor, deploy, dev:** ownership flags are checked against what will run them
  before anything is sent. A linked cloud or self-host target is asked
  `GET <schema base>/capabilities`; a server without the route (404) or whose engine does not list
  the feature is refused with "this server does not support <flag>; update it" rather than sent a
  field it would drop (an adopt of the previewed keys used to become an adopt of everything, and a
  consent to overwrite drift was lost). The engine binary path asks the binary that will actually
  run (`supatype-engine capabilities`, or its version for an older one), so `overrides.engine` and
  an offline cached engine work without the CDN; offline with nothing cached says what to do.
  `push` now sends `overwrite_drift`, the engine's own field name, to every target.
* **push:** a policy, grant, label or RLS attribute the schema changes that was also edited outside
  Supatype is shown and asked about like any other access drift (the engine's `replace` with
  `drifted`), and `deploy` refuses it without `--overwrite-drift`.
* **push (docker):** when the engine refuses to overwrite access changed outside Supatype, the push
  shows each object and, in a terminal, asks; a yes pushes again with `--overwrite-drift`.
  `supatype dev --overwrite-drift` applies it to every push of the session.
* **adopt:** a busy engine (another push, adopt or rebaseline holds its lock) is reported in the
  engine's own words, "busy, try again", instead of an exit code and log lines.
* **adopt:** on a docker project an empty key list reaches the compose engine as `--adopt-none`; it
  used to be sent as no keys, which adopts every conflict.
* **adopt:** declaring an adopted column never puts back content the CLI did not write: a file
  edited while the prompt was open is left as it is, with the field to add printed. A field whose
  import would bind a name the file already has is printed for a person to alias instead of
  written, and the read-back now catches a duplicate identifier. New lines use the file's own line
  endings. A NOT NULL integer column with no default may be an identity column, which no field type
  declares, so it is printed for a person rather than declared as a required field. Adopting a table
  no longer prints "add this field by hand" for the columns its model already declares.
* **push:** declining the prompt to put back access changed outside Supatype exits 1 on every push
  path. On a linked or self-hosted target the push said "Aborted" and exited 0, so a script could
  not tell a kept hand edit from an applied push; the docker path already exited 1. Both now print
  the same message and apply nothing.
* **dev, self-host:** a project whose `POSTGRES_USER` (in the shell or `.env`) names any user
  other than `supatype_admin`, for example `postgres`, is now refused before compose starts, on
  the bundled database only. The bundled Postgres image runs as `supatype_admin`, and with any
  other user the `db` container exited and `dev` waited ninety seconds to say only that the
  database never became healthy. **Migrating:** set `POSTGRES_USER=supatype_admin` in `.env` and
  the same user in `DATABASE_URL`. If the stack's data volume was created as the old user, either
  create the role in it first (connected as the old user:
  `CREATE ROLE supatype_admin WITH SUPERUSER LOGIN PASSWORD '<POSTGRES_PASSWORD>'`) or start again
  from an empty database with `supatype dev --reset-db`. A Postgres you run yourself, as its own
  user, belongs in `database.external.url`, which this check does not apply to.
* **dev:** a first schema push that fails because Docker could not pull an image no longer says
  "The engine refused the schema push" and asks for the schema to be fixed. The engine never ran,
  so `dev` now says Docker could not pull the image, that nothing was applied, and what to do: for
  Docker Hub's pull rate limit, `docker login` or wait; otherwise check the network and the image
  tag. A registry that could not be reached is no longer retried as though Postgres were starting.

## 0.3.6 (2026-10-02)

### Features

* **push:** when the engine refuses tables Supatype does not manage, `supatype push` and
  `supatype dev` say which tables and that their declared access rules are not in force, and in a
  terminal offer to adopt them there and then: the SQL adoption would run is shown, nothing is
  applied without a second yes, and the push runs again afterwards. Without a terminal, or with
  `--yes`, nothing is adopted and the command to run is printed. On a docker project adoption runs
  through the compose schema-engine, so it reaches the stack's database. The refusal is read from
  the engine's JSON reason, with its wording only as the fallback for an older engine.
* **adopt, doctor:** `--no-cache` is hidden and does nothing but say it is no longer needed: both
  read the database live. It never worked from the CLI (Commander stores it as `cache: false` and
  the commands read `noCache`), and `doctor` would have passed it to an engine subcommand that does
  not accept it.

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
* **dev:** `--reset-db` starts from an empty local database. It removes the Postgres data volume
  and nothing else, after a prompt that names the volume. Without a TTY it is refused unless
  `--yes` is passed as well. Nothing in `dev` removes data without it.

* **generate:** a rich text column is typed as the document it holds on the way out and as
  `RichText | string` on the way in. The engine emits a trigger that normalises a plain string
  into a Lexical document on insert and update, so prose can be written as prose while a read
  always returns the document. The seed builder gets the same split, and a tightening with it:
  the column was typed as any JSON at all, so a seed could write a bare number into one.

### Bug Fixes

* **connection:** every command that runs the engine on the host finds the database the same way,
  in seed's order: `--connection`, `database.external.url`, `connection` in the config,
  `DATABASE_URL` in the environment, `DATABASE_URL` in the project's `.env`, then the project's own
  database. `supatype adopt`, `introspect` and `migrate` on a docker project took the URL in
  `.supatype/environment.json`, which describes the `db` container, and failed looking up the host
  `db` (supatype#85). `doctor`, `pull` and `admin` read only the process environment, never `.env`.
  The derived default for a docker project is now the published compose database rather than the
  native layout (`postgres:postgres@127.0.0.1:5432/<name>`), which a docker stack does not have.
* **storage:** a bucket's `update` rule reaches the engine. Every key other than `read`, `create`
  and `delete` was skipped without a word, so an overwrite rule the author wrote was never
  enforced. Any other key in a bucket's `access` is now an error that names it.
* **push:** every push prints the engine's warnings, as `supatype diff` does, without repeating
  the ones the diff before it showed. None did, so a push said nothing about a bucket operation it
  had just made unreachable, and the warnings found after applying were shown nowhere.
* **dev:** a failed first schema push no longer wipes the local database. Every failure was
  answered with `docker compose down -v`, which removes every volume in the stack, Postgres and
  storage alike, so a push the engine refused on purpose (a table Supatype does not manage, a
  destructive change) cost the developer their rows and uploaded files, and the second attempt
  then succeeded against an empty database. Only a database that is not reachable yet is retried
  now, and the retry only starts Postgres again. A refusal stops `dev` with the engine's message
  and exits non-zero; for unmanaged tables it names `supatype adopt` as the remedy.
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
* **seed:** a project pinned to an engine with no `seed` subcommand is told so, by name, before
  anything is resolved or downloaded. It got a usage error about an unrecognised argument, which
  names nothing about the project and reads like a broken install.
* **push:** a schema with a rich text column is refused on an engine that cannot normalise one.
  The generated types accept a string on the way in and promise a document on the way out, and
  the trigger is what makes the second half true; an older engine emits no trigger and rejects
  nothing, so the push succeeded and a later read returned what the types call impossible.
