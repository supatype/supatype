---
title: "CLI"
description: "Every supatype command with its subcommands and most useful flags: local development, schema and database, seeds, functions, self-host and Supatype Cloud."
head:
  - tag: title
    content: "CLI | Supatype"
  - tag: meta
    attrs:
      property: "og:image"
      content: "https://www.supatype.com/og/cli.png"
---

Every `supatype` command, grouped by what it is for. Descriptions are the ones `supatype --help` prints.

Pre-1.0: APIs and config may change between releases.

<h2 id="usage">Install and help</h2>

```sh
$ npm install -g @supatype/cli
$ supatype --help
$ supatype push --help
```

The npm package needs Node.js 22 or later. It is the install to use on Windows.

On a Linux or macOS machine without Node, such as a CI image or a server, install the standalone binary instead, with the script or with Homebrew:

```sh
$ curl -fsSL https://supatype.com/install.sh | bash
$ brew install supatype/tap/supatype
```

The script installs one binary to `~/.supatype/bin` and adds that directory to your shell profile. It checks the release signature with `openssl` before installing. Where `openssl` is missing or cannot check ed25519 signatures, as with the LibreSSL macOS ships, it says so and checks only the SHA256. On Alpine it installs the musl build, which needs `apk add libstdc++ libgcc`. The components `dev` downloads are built for glibc only, so run local stacks on a glibc image. `supatype self-update` updates a standalone install.

Run commands from the project directory, where `supatype.config.ts` is. Every command also takes `--project-name <name>`, which names the project for this run over `supatype.config.ts`. `supatype --version` prints the CLI version.

`--project-name` is the same as setting `SUPATYPE_PROJECT_NAME`, and it writes no file. The Compose project, the native database and the state directory under `~/.supatype/projects/` all follow it. Use it to run two stacks of one project side by side, each with its own `SUPATYPE_KONG_PORT`. The name may use lower case letters, digits, `-` and `_`, and must start with a letter or digit.

Many commands that reach a database take `--connection <url>` to override the config, and `--env <name>` to pick an environment when the project is linked.

:::note[Cloud]
Commands marked **Cloud** need Supatype Cloud, which is coming soon. Everything else works locally and on a self-hosted stack.
:::

<h2 id="project">Project and local development</h2>

| Command | Description | Useful flags |
| --- | --- | --- |
| `init [name]` | Scaffold a new Supatype project | `-y, --defaults`, `--no-install`, `--no-keys`, `--admin-email`, `--admin-password`, `--no-admin` |
| `dev` | Start local Postgres, apply schema, and run supatype-server | `--no-watch`, `--stream`, `--port <port>`, `--reset-db` (Docker only), `--yes`, `--overwrite-drift` |
| `keys` | Generate ANON_KEY and SERVICE_ROLE_KEY JWTs from your JWT_SECRET | `--write`, `--force`, `--secret <secret>`, `--exp-years <years>` (default 10) |
| `status` | Show linked target status or local stack services | `--env <name>` |
| `logs` | Tail logs from the local stack | `--service <name>`, `--since <duration>` (default 5m), `-f, --follow` |
| `app add [dir]` | Configure app routing: --static for a built site, or proxy to a dev server | `--static`, `--port <port>` (default 3000), `--upstream <url>` |
| `app remove` | Set app.mode=none in supatype.config.ts |  |
| `admin create-user` | Create an admin user for the admin panel | `--email`, `--password` (asked for if left out), `--role` (default `admin`) |
| `admin set-role` | Change an existing user's admin role | `--email` and `--role`, both required |
| `admin list-users` | List users with Studio access | `--connection <url>` |
| `pg start` | Start Postgres for the current project | Native provider only |
| `pg stop` | Stop Postgres for the current project |  |
| `pg reset` | Stop Postgres, wipe the data directory, and re-initialise | `--force` |
| `pg psql [dbname]` | Open a psql shell connected to the project database |  |

`--role` is `admin`, `developer`, `editor` or `viewer`. See [Studio roles](/docs/studio-roles.html#grant). The first-run steps are in [Local development](/docs/#local-dev).

`keys` prints the keys unless you pass `--write`, which fills blank keys in `.env`. Add `--force` to replace keys already there.

`dev` and `self-host compose up` refuse a `JWT_SECRET` shorter than 32 characters before starting anything, because the REST API cannot start with one. `init` generates a 64-character secret. To replace a short one, generate a longer secret (for example with `openssl rand -base64 48`), put it in `.env` as `JWT_SECRET`, then run `supatype keys --write --force` to sign new keys with it.

<h2 id="schema">Schema and database</h2>

| Command | Description | Useful flags |
| --- | --- | --- |
| `push` | Push schema to the database: diff, prompt for destructive changes, apply migration, generate types | `--yes`, `--connection <url>`, `--env <name>`, `--direct` (alias `--local`), `--overwrite-drift` |
| `diff` | Show planned schema changes without applying them (dry run) | `--connection <url>`, `--env <name>`, `--direct` |
| `generate` | Regenerate TypeScript types without running a migration |  |
| `migrate` | Write the SQL a push would apply, without applying it. Plain, it takes no lock your application waits on and the file records nothing: applied by hand, the next push finds the tables unmanaged. With --record the file also records the migration as a push does | `-o, --output <file>`, `--record`, `--force` |
| `migrations list` | List applied migrations with schema snapshot metadata | `--connection <url>`, `--env <name>` |
| `rollback` | Roll back the last applied migration | `--sync-schema`, `--no-sync-schema` |
| `reset` | Drop all managed tables and re-apply the schema from scratch (destructive) | `--yes`, `--connection <url>` |
| `rename [from] [to]` | Record a rename in supatype/renames.json, so every push applies it as a rename and keeps the data: `supatype rename member.name member.title`, or `supatype rename member members` for a table | `--prune` |
| `doctor` | Report schema drift between schema/index.ts and the live database | `--strict`, `--rebaseline`, `--accept-access-drift`, `--yes` |
| `adopt` | Hand Supatype the objects a push refuses because their names are taken; take objects back with --release, and hand them back with --reclaim | `--release <object...>`, `--reclaim <object...>`, `--key <object...>`, `--adopt-none`, `--yes` |
| `pull` | Scaffold schema/index.ts from live database introspection (draft, review before push) | `--connection <url>`, `--out <path>`, `--dry-run` |
| `introspect` | Introspect the live Postgres database (JSON or summary) | `--json`, `--out <path>` |
| `db check` | Check whether a database meets Supatype's requirements (for external Postgres) | `--connection <url>`, `--schema <name>`, `--emit`, `--fix`, `--authenticator-password <password>` |
| `types check` | Validate generated client augmentation wiring |  |

`--direct` skips the control plane of a linked project and runs the schema engine on this machine. `generate` reads only the schema, so it needs no database. `pull` prints its draft unless you pass `--out`. `migrations list` shows each migration's author, how many schema files its snapshot holds and their compressed size, and the renames it applied.

A push never guesses a rename. A column that disappears while a new one appears is a drop and an add, and the drop loses data. In a terminal the push asks whether you meant a rename and records a yes in `supatype/renames.json`. Anywhere else it refuses and prints the `supatype rename` command that records it.

An object passed to `adopt` is named as `doctor` names it: `kind:table.name`, or `kind:name` for a table. Studio shows the result under [Schema objects](/docs/studio.html#database).

:::note[Pull]
`pull` writes a draft. Review it before you push: it types every uuid `id` column as `SupatypeAuthUserId` and does not write `tableName`, so fix those by hand.
:::

<h2 id="data">Data and seeds</h2>

| Command | Description | Useful flags |
| --- | --- | --- |
| `seed [file]` | Run database seeds: optional single file; else all seeds/*.ts (alphabetical); else seed.ts | `--status`, `--atomic`, `--connection <dsn>`, `--environment <name>` |
| `cache rest list` | List cached REST GET entries | `--table <name>`, `--json` |
| `cache rest get <key>` | Show one cache entry (full key) | `--json` |
| `cache rest delete <key>` | Delete one cache entry |  |
| `cache rest flush` | Flush REST cache entries | `--table <name>`, `--yes` |

`seed` refuses to run against a project linked to Supatype Cloud unless you pass `--force`. See [Seeding](/docs/seeding.html).

<h2 id="functions">Functions and hooks</h2>

| Command | Description | Useful flags |
| --- | --- | --- |
| `functions new <name>` | Scaffold a new edge function |  |
| `functions serve` | Start a local Deno server that serves all functions with hot reload | `--port <port>` (default 54321), `--env-file <path>` (default `.env.local`) |
| `functions invoke <name>` | Invoke a local or deployed function | `--data <json>`, `--auth`, `--local` |
| `functions deploy` | Deploy all functions (or --only <name> for one) to the linked project | `--only <name>`, `--env <name>`, `--dry-run` |
| `functions list` **Cloud** | List all deployed functions for the linked project |  |
| `functions delete <name>` **Cloud** | Remove a deployed function |  |
| `functions logs <name>` **Cloud** | Tail logs for a deployed function | `--since <duration>` (default 1h) |
| `functions env list`, `set <KEY=value>`, `unset <key>` **Cloud** | Manage function environment variables |  |
| `hooks new <name>` | Scaffold a hook handler |  |
| `hooks list` | Show the hooks the schema declares and whether each one can run |  |

On an unlinked project with a self-hosted Compose stack, `functions deploy` uploads nothing: the worker serves `functions/` from disk, so it lists the functions and prints the command that restarts the worker. Otherwise it deploys to the linked project, or to Supatype Cloud. On a self-hosted stack, read function logs in Studio. See [Functions](/docs/functions.html).

<h2 id="self-host">Self-host and deploy</h2>

| Command | Description | Useful flags |
| --- | --- | --- |
| `self-host compose render` | Render deterministic self-host compose artifacts |  |
| `self-host compose up` | Render and start compose services | `-d, --detach` (on by default) |
| `self-host compose down` | Stop compose services (volumes are kept unless --volumes) | `--volumes`, `-y, --yes` |
| `self-host compose restart <service>` | Recreate one service with the current config and .env, leaving the others running |  |
| `self-host compose status` | Show compose service status |  |
| `self-host compose logs` | Tail compose logs | `--service <name>`, `-f, --follow` |
| `add domain [domain]` | Add a custom domain with automatic HTTPS (self-host) | `--email <email>` for Let's Encrypt |
| `link` | Link this project to cloud or self-host (unified .supatype/link.json) | `--url <url>`, `--token <token>`, `--env <name>`, `--fix-gitignore` |
| `envs list` | List linked environments |  |
| `envs use <name>` | Set the default environment |  |
| `deploy` | Deploy schema and app, Supatype Cloud by default when linked (`supatype link`); pass --local for engine + your database | `--env <name>` (default `production`), `--schema-only`, `--app-only`, `--skip-build`, `--preview`, `--yes`, `--overwrite-drift` |
| `deploy rollback` | Roll back to the previous static site deployment | `--to <id>`, `--env <name>` |
| `deploy status` | Show current deployment status | `--env <name>` |
| `deploy logs [version]` | Show build logs for a deployment | `--env <name>` |

Every `self-host compose` command renders `.supatype/self-host/docker-compose.yml` again before it runs. The file names each bind mount by its absolute path on this machine, and names its Compose project `supatype-` plus `project.name`. So `docker compose -f .supatype/self-host/docker-compose.yml` run by hand reaches the same stack, and a project moved to another folder is picked up by the next command.

A render keeps the stack in the mode it runs in. While `supatype dev` runs for the project, commands such as `push`, `update` and `self-host compose` render dev mode. Otherwise they use the mode of the running `server` container, and standalone when none is running. So a push to a production stack leaves it standalone.

For a self-hosted stack, `link --url` takes the stack's gateway URL and `--token` its `SERVICE_ROLE_KEY`. The full walkthrough is in [Self-host](/docs/#self-host) and [Deploy to a VM with GitHub Actions](/docs/guides/deploy-vm-github-actions.html).

<h2 id="cloud">Supatype Cloud</h2>

All of these need Supatype Cloud, which is coming soon.

| Command | Description | Useful flags |
| --- | --- | --- |
| `login` | Sign in to Supatype Cloud (stores refreshable session for push/deploy) | `--email <email>`, `--password <password>` (prefer `SUPATYPE_PASSWORD`) |
| `logout` | Clear stored Supatype Cloud credentials |  |
| `whoami` | Show the current Supatype Cloud session |  |
| `link --project <slug>` | Link this project to cloud or self-host (unified .supatype/link.json) | `--token <token>`, `--env <name>` |
| `projects list` | List all projects in your organisation |  |
| `projects create <name>` | Create a new project | `--tier <tier>`, `--region <region>` |
| `projects pause <slug>` | Pause a project |  |
| `projects resume <slug>` | Resume a paused project |  |
| `domains list`, `add <domain>`, `remove <domainId>`, `verify <domainId>` | Manage custom domains for a project |  |
| `envs create <name>` | Create a cloud environment (staging/preview) |  |
| `db connection-string` | Show the database connection string for the linked project | `--transaction`, `--env <name>` |
| `db reset-password` | Reset the database password for the linked project | `--env <name>` |

<h2 id="misc">Binaries and updates</h2>

| Command | Description | Useful flags |
| --- | --- | --- |
| `self-update` | Update the supatype CLI (npm or standalone CDN binary) | `--force` |
| `update` | Download the latest component binaries and update versions in supatype.config.ts | `--check` |
| `engine status` | Run the host engine binary's --version and show which binary answered |  |
| `cache list` | List cached component binaries and their sizes | `--project <path>` |
| `cache clean [component] [version]` | Remove cached binaries not pinned by local project configs | `--dry-run`, `--force`, `--project <path>` |
| `migrate-from-v1` | Codemod runtime model() schema DSL into RFC v2 Model<> type aliases | `--schema <path>`, `--write` |

Binaries are cached in `~/.supatype/cache/`. `cache clean --force` removes every cached binary, pinned or not.
