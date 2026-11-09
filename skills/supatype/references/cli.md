# CLI reference

Install: `npm install -g @supatype/cli` or use `npx @supatype/cli`.

Global flags (all commands): `--project-name <name>` (one run under another project name, see
below), `-V`/`--version`, `-h`/`--help`. There is no global `--config`, `--verbose`, `--json` or
`--no-color`; `--env`, `--connection` and `--json` are per-command options where a command takes them.

Downloaded components land in `~/.supatype/cache/<component>/<version>/`, each checked against its
release's signed checksums. With the schema engine the CLI also saves its `LICENSE` there and
prints `[supatype] Supatype engine is licensed under BUSL-1.1; see <path>/LICENSE` (or warns
`The engine's LICENSE was not saved: <reason>. The engine is licensed under BUSL-1.1.` when the
release publishes none; the engine still installs).

## Project lifecycle

| Command | Purpose |
|---------|---------|
| `supatype init [name]` | Scaffold a project. Interactive in a terminal: it asks where the project will run in production and whether to create a first Studio admin, installs the packages and writes the keys, then prints the URL to open. Flags: `-y`/`--defaults` (no prompts, sensible defaults), `--no-install`, `--no-keys`, `--admin-email <email>`, `--admin-password <password>`, `--no-admin`, `--mode dev \| standalone` (kept for older scripts; prefer the prompts or `--defaults`). In a Next.js App Router app it writes `app/supatype-env.js/route.ts` (`@supatype/ssr/next`), loads `/supatype-env.js` first in the root layout with `next/script` `beforeInteractive`, and adds `@supatype/ssr`; a Pages Router app, or a layout it cannot edit safely, gets the lines printed instead (see [frontend.md](frontend.md#nextjs)). A static app's `index.html` gets `<script src="/supatype-env.js" vite-ignore></script>` in the head, before the app's own script (load it without `async` or `defer`) |
| `supatype keys` | Generate `ANON_KEY` + `SERVICE_ROLE_KEY` from `JWT_SECRET` (fills blanks in `.env` when there is one, `--force` replaces them; `--print`, or no `.env`, only prints, and `--print` with no secret anywhere exits 1 rather than inventing one; `--write` is accepted for older scripts, and contradicts `--print`). `--print frontend [--env <name>] [--allow-local]` prints a deployment's API URL and anon key under every front-end prefix instead, one `NAME=value` line each and nothing else on stdout, for a host's settings or `>> "$GITHUB_ENV"`; it resolves them as `supatype build` does and refuses the same way (any other target is refused, listing the valid ones; `--env` or `--allow-local` without `--print frontend` is refused; `--allow-local` takes a local stack's address). The front end's copies (`VITE_`, `PUBLIC_`, `NEXT_PUBLIC_`, `EXPO_PUBLIC_` names for the anon key and the recorded URL) go to `.env.development.local` when `.env`'s URL is a local stack's, else to `.env` (see [frontend.md](frontend.md#frontend-env-files)). The `JWT_SECRET` rule, shared by `keys`, `dev`, `init` and `self-host compose up`: `.env`'s always wins; a shell `JWT_SECRET` is used only when `.env` has none, and is then written into it; a shell one that differs from `.env`'s gets one warning line saying `.env`'s is used, never a refusal; only a `--secret` that differs from `.env`'s is refused. When a `JWT_SECRET` is newly written into `.env`, both keys are signed again with it. Every docker compose command runs without the shell's `JWT_SECRET`, `ANON_KEY` and `SERVICE_ROLE_KEY` when `.env` defines them. `JWT_SECRET` must be at least 32 characters, and one written into `.env` must hold no whitespace, `#` or quotes; the secret is checked before anything is written, and `dev`, `keys` and `self-host compose up` refuse a shorter one in `.env` with `JWT_SECRET in .env is <n> characters, and the REST API needs at least 32.` (`init` warns and generates one instead of using an unusable shell secret.) |
| `supatype dev` | Start local stack + control-plane. Docker default (Kong on `SUPATYPE_KONG_PORT` from `.env`). Watches the schema, and `functions/` and `hooks/`: a saved function or hook restarts the functions worker, so the next call runs the new code (native dev reloads through `deno run --watch`). Flags: `--no-watch` (no schema watch, and no worker restarts under Docker), `--stream`, `--port`, `--reset-db` (remove only the Postgres data volume, after confirmation), `--yes` (skip that confirmation; required for `--reset-db` without a TTY), `--overwrite-drift` (every push of the session puts back access changed outside Supatype). Renders `auth.providers` for the auth server and warns about an enabled provider whose secret is set nowhere (config.md, OAuth providers). Native: Postgres checks passwords (`scram-sha-256`, `.env`'s `POSTGRES_PASSWORD` and `AUTHENTICATOR_PASSWORD`, generated when missing); a `trust` data directory from an older CLI is converted on its next start, printing "This Postgres trusted every local connection; it now checks passwords." `supatype pg psql` passes the password |
| `supatype push` | Diff, migrate, generate types. Flags: `--yes`, `--connection`, `--env`, `--direct`, `--overwrite-drift`. Against the project's compose stack or a linked self-host server it then waits (at most 40 s, printing `[supatype] Waiting for the REST API to load the new schema (PostgREST answers 503 until it does)...`) until `/rest/v1/` stops answering 503; giving up does not fail the push. On the Docker provider a push the engine refuses over access changed outside Supatype shows each object and, in a terminal, asks before putting it back. On every path, declining keeps the hand edits, applies nothing and exits 1. A change that rewrites a table of more than 100k estimated rows (a type change that is not binary-compatible, say) locks it while it runs: the plan says so with the table's size, and the push asks in a terminal, applies it with `--yes`, and refuses it anywhere else. Each attempt waits at most 3 seconds for a table lock and the push tries again a few times; if a session still holds the table, it fails naming the table and that session's pid, state and age, having applied nothing. A new index on a table with rows is built concurrently, and a new foreign key or check validated, after the migration commits, so neither stops the application's writes |
| `supatype diff` | Dry-run schema changes. Flags: `--connection`, `--env`, `--direct` |
| `supatype generate` | Regenerate types without migration |
| `supatype seed [file]` | Apply seed data, one transaction per file, so a failure leaves the earlier files committed. Flags: `--atomic` (every file in one transaction), `--status`, `--connection`, `--environment`, `--force`. See [seeding.md](seeding.md) |

## Linking (unified)

All targets use `.supatype/link.json` with an `environments` map:

| Command | Purpose |
|---------|---------|
| `supatype link --project <ref>` | Link to Supatype Cloud (uses platform access token) |
| `supatype link --url <api> --token <key>` | Link to self-host (the server's `SERVICE_ROLE_KEY`, which `supatype keys` puts in its `.env`) |
| `supatype link --env staging --url ... --token ...` | Add another environment |
| `supatype envs list` | List linked environments and the default commands use (`environments` in supatype.config.ts wins over `envs use`) |
| `supatype envs use <name>` | Set this checkout's default environment; warns when the config names another |
| `supatype envs create <staging\|preview>` | Create a Supatype Cloud environment and add it to link.json (cloud link only; any other name is refused). For self-host, use `supatype link --env <name> --url ... --token ...` |
| `supatype domains list` / `add <domain>` / `verify <id>` / `remove <id>` | Cloud custom domains; `verify` and `remove` take the ID `list` prints |

Legacy `.supatype/cloud.json` and `.supatype/linked.json` migrate into `link.json` on first read.

Auth flag: `--token` (cloud = platform PAT; self-host = `SERVICE_ROLE_KEY`). `--service-role-key` is a deprecated alias.

## Schema and database

| Command | Purpose |
|---------|---------|
| `supatype doctor` | What a push would find: missing, drifted, stale, conflicting, unmanaged and released objects. Flags: `--env`, `--direct`, `--strict` (fail when a push would change or refuse something), `--rebaseline` (record drifted objects as they are now, changing nothing; after a Postgres upgrade; shows them and asks, `--yes` when not interactive; policies, grants, labels and RLS only with `--accept-access-drift` too, else listed as not rebaselined; `--overwrite-drift` is push's flag and doctor refuses it, pointing here) |
| `supatype adopt` | Hand Supatype the objects a push refuses because their names are taken; records ownership, never edits the object. Agreed at the prompt, it adopts only what its preview listed; `--yes` alone adopts every conflict there is and lists what it took; `--key kind:table.name` (repeatable) adopts only those. If an object it was to adopt is no longer a conflict, it writes nothing and exits 1 asking you to run it again. `--release kind:table.name` makes every push leave an object alone, and `--reclaim kind:table.name` hands it back. `--key column:table.name` adopts a column added outside Supatype (one the schema does not declare, e.g. one doctor or push says has no write grant), and adopted means managed: the CLI then adds the field to the model whose table it is, keyed by the column name, with the field type whose column is exactly the live one (an identity column as `Identity<number>`, `Identity<bigint, "by-default">` or `SmallInt<{ identity: … }>`, a generated one as `Generated<T, "<expression>">`), and regenerates types, so the next `push` treats it as declared. In a terminal it shows the file, model and field line and asks (y/N) first; `--yes` edits without asking, CI included. If the model cannot be found, its fields are not written inline, or the column's type has no exact field type (for example `varchar`, `timestamp` without time zone, an unbounded `numeric`, or a generated `jsonb` column), or the field's import would clash with a name the file already has, or you decline, or the file changed while you were asked, the file is left alone and it prints the field line and where to add it; the adopt still succeeds and it exits 0. Flags: `--env`, `--yes` (required when not interactive), `--release`, `--reclaim`, `--key` (each checked against the server or engine first). `push` and `dev` offer to run it when they find unmanaged tables |
| `supatype introspect` | Introspect live Postgres. Flags: `--connection`, `--env`, `--json`, `--out <path>` (write the JSON to a file), `--direct` |
| `supatype migrate` | Write the SQL a push would apply, without applying it. Plain, it is planned without taking any lock your application waits on, and the file records nothing: applied by hand, it writes no migration history and no record of which objects are Supatype's, so the next `push` finds the tables unmanaged (its header says so). `--record` rehearses the push in a transaction that is rolled back, so the file also records the history and the ledger and applying it by hand is the push; while it rehearses it takes the table locks a push takes. A new index on a table with rows is built with `CREATE INDEX CONCURRENTLY`, and a new foreign key or check is added `NOT VALID` and validated, after the file's transaction (plain only). Flags: `--connection`, `--record`, `--force` (destructive changes and rewrites of large tables), `-o, --output <file>` |
| `supatype rollback` | Undo the last applied migration (linked or direct). Flags: `--env`, `--connection`, `--direct`, `--sync-schema`, `--no-sync-schema` |
| `supatype migrations list` | List applied migrations with snapshot metadata. Flags: `--env`, `--connection`, `--direct` |
| `supatype rename <from> <to>` | Record a rename in `supatype/renames.json` (commit it): `member.name member.title` for a column, `member members` for a table. Every push replays the journal, so each database renames instead of dropping. `--prune` removes entries the target already applied. In a terminal, `dev` and `push` offer to record a likely rename before asking to drop data |
| `supatype db connection-string` | Show DB URL (cloud linked projects) |
| `supatype db reset-password` | Reset cloud project DB password |
| `supatype db check` | Check whether a Postgres you run yourself has what Supatype needs. Flags: `--connection <url>`, `--schema <name>`, `--emit` (print the SQL that fixes it), `--fix` (apply that SQL in one transaction), `--authenticator-password <password>` |
| `supatype pg start` / `stop` / `reset` / `psql [db]` | Native Postgres helpers; `psql` passes `.env`'s `POSTGRES_PASSWORD` |
| `supatype pull` | Draft `schema/index.ts` from live DB introspection (review before push); identity and generated columns are declared as such. Flags: `--connection`, `--out`, `--dry-run` |

## App and deploy

| Command | Purpose |
|---------|---------|
| `supatype app add` | Add static or proxy app to compose (e.g. `--static ./public`) |
| `supatype app remove` | Remove app from compose |
| `supatype add domain [domain]` | Add a custom domain with automatic HTTPS (self-host). Interactive, or pass `--email <addr>`. Sets `server.mode=standalone` + `domain` + `tls`; apply with `compose up -d` |
| `supatype self-host compose render` | Write docker-compose.yml without starting anything (`up` and the other compose commands render it themselves) |
| `supatype self-host compose up -d` | Start production stack. Fills blank keys in `.env`, signed with its `JWT_SECRET` (both signed again when a `JWT_SECRET` is newly written there); a shell `JWT_SECRET` that differs from `.env`'s is warned about and not used. Once the stack answers, creates the schema's declared storage buckets and the first admin user (a failure there is a warning; the stack stays up) |
| `supatype self-host compose down` | Stop stack. `down`, `status` and `logs` run against the compose file already on disk instead of rewriting it, so they skip the URL-safe password check that only the commands starting containers make (`dev` at startup, `self-host compose up`, `render`, `restart`), and a stack started with an older password can still be stopped (with no file on disk yet they render one, without the check). `update`, push and diff never refuse over it either |
| `supatype self-host compose status` | Health check |
| `supatype self-host compose restart <service>` | Recreate one service (e.g. `server`, `functions-worker`) with the current config and `.env`; the others keep running |
| `supatype self-host compose logs` | Follow logs. `--service <name>` for one service |
| `supatype build [-- <command...>]` | Run the app's production build (the package.json `build` script through the project's package manager, or the command after `--`) with the deployment's API URL and anon key under every front-end prefix (`VITE_`, `PUBLIC_`, `NEXT_PUBLIC_`, `EXPO_PUBLIC_`). Each value from the first of: the environment (`SUPATYPE_URL` / `SUPATYPE_ANON_KEY` or a prefixed name), for the anon key only the `/supatype-env.json` of the server the environment's URL names (so CI sets just `SUPATYPE_URL`), the linked environment (Cloud keys route, or a self-host server's `/supatype-env.json` over HTTPS), a `.env` recording a deployment (`PUBLIC_SUPATYPE_URL` or `API_EXTERNAL_URL`, and `ANON_KEY`). An anon key counts only for the URL being built for: one held for another deployment is listed as `skipped ... not the URL being built for`. Refuses before building when either is missing, the URL is local, or the "anon key" is a service role key, listing every source tried. Writes no file; exit code is the build's. A bare `supatype build` inside a build it started (a package.json `"build": "supatype build"`) refuses rather than loop; `supatype build -- <command>` nested still runs. Flags: `--env <name>` (default: the link's default), `--allow-local`. See [frontend.md](frontend.md#production-builds) |
| `supatype deploy` | Deploy schema + static app to linked target. Flags: `--local`, `--env`, `--schema-only`, `--app-only` (static site only), `--skip-build` (deploy the existing build), `--preview` (a temporary preview URL), `--yes` (skip confirmations), `--overwrite-drift` (without it a deploy refuses on access changed outside Supatype), `--allow-local` (build the app against a local stack's address, otherwise refused). The app's build gets the URL and anon key as `supatype build` resolves them, and the deploy stops before building without them |
| `supatype deploy status` | Current static deployment |
| `supatype deploy rollback` | Roll back static deployment. Flags: `--env`, `--to <deployment-id>` |

## Single sign-on (SAML)

Turn SAML on with `auth: { sso: { saml: { enabled: true } } }` in `supatype.config.ts`; the next
`supatype dev` or `self-host compose up` writes `SUPATYPE_SAML_PRIVATE_KEY` to `.env` (never the
config). The `sso` commands call the auth admin API on the linked self-hosted deployment, else the
running local stack (not Supatype Cloud yet). Every `sso` command warns while SAML is off; providers can still be set up.

| Command | Purpose |
|---------|---------|
| `supatype sso add <name>` | Register an identity provider. `--metadata-url <url>` (fetched by the server, so reachable from its container; https, http on a dev stack only; an unreachable one is a 400 `saml_metadata_fetch_failed`: "The server could not fetch SAML metadata from <host>: <reason>...") or `--metadata-file <path>`, `--domains a.com,b.com`, `--attribute-mapping-file <path>`, `--name-id-format persistent\|emailAddress\|transient\|unspecified` |
| `supatype sso list` / `show <name>` | List providers, or show one (ID, entity ID, domains marked verified or not) |
| `supatype sso update <name>` | Change in place; same flags, all optional; `--domains` replaces the list. Never remove and re-add: users are tied to the provider's ID |
| `supatype sso remove <name>` | Remove (`-y` to skip the question) |
| `supatype sso info` | Print the SP entity ID (= metadata URL), ACS URL and metadata URL; with SAML on, also the signing certificate as PEM under its SHA-256 fingerprint, read from the served metadata, and during a rotation the next certificate. With SAML off it warns the values are not served yet |
| `supatype sso verify-domain <name> <domain>` | Print and check the `_supatype-challenge.<domain>` TXT record; exits 1 until verified. Only a verified domain links a SAML sign-in to an existing account with the same email (on an unverified domain that sign-in is refused; with no existing account a new one is made either way). `.supatype.test` counts as verified on a dev stack |
| `supatype sso rotate-key [--promote] [-y]` | Create `SUPATYPE_SAML_NEXT_PRIVATE_KEY`, restart (metadata lists both certificates), update the IdPs, then `--promote` and restart again |

Full guide: https://www.supatype.com/docs/sso.html

## Functions and extensions

| Command | Purpose |
|---------|---------|
| `supatype functions new <name>` | Scaffold `functions/<name>/index.ts` plus Deno IDE types (`functions/deno.d.ts`, `functions/tsconfig.json`) |
| `supatype functions serve` | Local Deno server for all functions, on port 18472 unless `--port` moves it |
| `supatype functions deploy` | Deploy edge functions via control plane when linked. On a self-host compose stack nothing is uploaded (the worker reads `functions/` from disk): run `supatype self-host compose restart functions-worker` to load changes (`supatype dev` does that on save) |
| `supatype functions list` | List deployed functions |
| `supatype functions env set KEY=value` / `list` / `unset KEY` | A function's env values: on the linked project, else `functions/.env.local`. With `functions/.env.<name>.local` (one function, wins), every value arrives in `ctx.env`, read again on each call, never in `Deno.env`: that is the worker's one process environment, shared by every call running at once, so `Deno.env.get` finds none of them |
| `supatype plugins` | Plugin scaffolding. A plugin cannot run SQL: the SDK has no `installSQL` or `uninstallSQL`, and `defineComposite` refuses either |
| `supatype types` | Type utilities |

A handler is `(req, ctx)`, with `ctx` typed by `functions/_shared/context.ts` (rewritten by `init`, `functions new`, `push` and `dev`). `ctx.url` is for calling the API from inside the function (under Docker, `http://kong:8000`, which no browser can open); `ctx.publicUrl` is the project's public address, for links you give to people. The scaffolded function returns `publicUrl`.

Example: [`examples/edge-kit`](https://github.com/supatype/supatype/tree/main/examples/edge-kit) in the Supatype repository: a Vite UI that invokes sample functions.

## Ops and maintenance

| Command | Purpose |
|---------|---------|
| `supatype status` | Linked target summary or local dev stack health. Flag: `--env` |
| `supatype logs` | View logs |
| `supatype admin` | Admin user provisioning |
| `supatype update` | Update pinned component versions |
| `supatype cache` | Binary/image cache management |
| REST GET cache | See [caching.md](caching.md): `.cache({ ttl, server })` on queries |
| `supatype engine` | Schema engine utilities |

## Local Docker dev: ports, multiple projects, shutdown

**Kong port (`SUPATYPE_KONG_PORT`):**
- `supatype init` (Docker) prompts for a gateway port; default is `18473` or the next free port.
- Each project should have a **unique** `SUPATYPE_KONG_PORT` in `.env` so multiple stacks can run concurrently.
- `supatype dev` re-checks the configured port; if it is taken, you can pick another interactively.
- Open the URL printed by `supatype dev`, not always `:18473`.

**Stopping the stack:**
- `supatype dev` runs `docker compose down` on Ctrl+C, terminal close, and as a sync fallback on process exit. It also stops, the same way, within a few seconds of the process that started it exiting (a script killed outright, a cancelled CI job), so it never runs on orphaned. It says so as it stops. `dev` has no option to outlive its parent: to keep a stack up with nothing attached, use `supatype self-host compose up -d`. A script that backgrounds `dev` should `exec` it, `(cd app && exec npx supatype dev) & DEV_PID=$!`, so the PID it later kills is `dev` itself (without `exec`, older bash leaves `$!` naming a subshell and killing it left `dev` running).
- Ownership flags (`--overwrite-drift`, `adopt --key/--release/--reclaim`, `doctor --rebaseline/--accept-access-drift`, and the keys an agreed adopt sends) are checked first against what will run them: a linked server's `GET .../schema/capabilities`, or the engine binary's `capabilities` (its version for an older one). A server or engine that lacks one is refused with "this server does not support <flag>; update it", never sent the flag to drop it.
- A failed schema push never resets the database. `dev` retries only while Postgres is unreachable; an engine refusal (for example unmanaged tables, fixed with `supatype adopt`) stops `dev` with the engine's message. `supatype dev --reset-db` is the only way `dev` removes data, and it removes only the Postgres volume.
- `.supatype/dev-session.json` tracks the active dev session, with `dev`'s process ID; the next `supatype dev` offers to clean up a stack left running after an unclean exit. A file whose process is gone (or that names none) is removed and ignored, so it never makes another command render the stack as dev.
- No command starts the local stack or its Postgres implicitly. On a Docker project with the stack stopped, `push`, `diff`, `adopt`, `doctor`, `seed`, `migrate`, `migrations list`, `rollback`, `reset`, `introspect`, `pull`, `admin`, `cache rest` and a local `functions invoke` (one no `functions serve` answers) refuse before doing anything: "The local stack isn't running. Start it with `supatype dev`, or `supatype self-host compose up -d` on a server, then run `supatype <command>` again." `seed` exits 2, the others 1. A linked project, `--connection`, `connection` in the config, an external database, and an API address named by `SUPATYPE_URL` or `SUPATYPE_API_URL` in `.env` are unaffected.
- On a running stack, `push` runs `up -d` for what the schema changed, then creates declared buckets and the first admin. A step after the apply that fails is a warning: the push still exits 0.

**Renaming `project.name`:**
- Docker compose project slug changes (`supatype-{name}`). On the next `supatype dev`, the CLI detects the rename via `.supatype/environment.json` and offers to stop the old stack (volumes preserved).

**One run under another name (`SUPATYPE_PROJECT_NAME`, `--project-name`):**
- Either renames the project for that command only, over `project.name`, and writes no file: the compose project, the database and the state directory all follow it. Use it to run two stacks of one project side by side, from two checkouts, each with its own `SUPATYPE_KONG_PORT`.
- It must be lower case letters, digits, `-` and `_`, starting with a letter or digit.
- It is not a rename: `.supatype/environment.json` keeps the config's name, so the next run without it does not offer to stop anything.

## Typical sequences

**First run:**
```bash
npx @supatype/cli init my-app   # installs dependencies, writes the keys, prints the URL to open
cd my-app
npm run dev                     # supatype dev: applies the schema, generates types, watches both; no push locally
```

**Remote self-host (no local Postgres):**
```bash
supatype link --url https://app.example.com --token $SERVICE_ROLE_KEY
supatype push
supatype functions deploy
supatype deploy
supatype status
```

**Schema change:**
```bash
supatype diff
supatype push          # or: supatype push --yes
supatype push --direct # bypass control plane, use local engine
supatype migrations list --env staging
supatype rollback --env staging   # DB revert + optional schema file restore from DB snapshot
supatype rollback --no-sync-schema  # database only
```

**Rollback notes:** `supatype rollback` undoes exactly the last applied migration on the shared database. Schema source files can be restored from the gzip snapshot stored in `_supatype.migrations` (not from git). One-step undo only: older migrations require sequential rollbacks or a forward-fix migration.

**Self-host production:**
```bash
supatype add domain demo.example.com --email you@example.com  # automatic HTTPS (Kong ACME)
supatype self-host compose up -d                              # publishes :80/:443, issues cert on first hit
supatype build                                                # .env: API_EXTERNAL_URL=https://demo.example.com, ANON_KEY
supatype self-host compose up -d                              # serve the new build
supatype link --url https://demo.example.com --token $SERVICE_ROLE_KEY
supatype deploy
```
