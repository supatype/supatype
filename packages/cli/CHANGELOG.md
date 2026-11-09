# Changelog

## Unreleased

### Breaking Changes

* **storage:** the storage service's S3 settings have no defaults that point somewhere. With
  `STORAGE_BACKEND=s3` it used to fall back to `http://localhost:8333` and the SeaweedFS login
  published in this repository for any setting left out. It now needs `S3_REGION` for AWS or
  `S3_ENDPOINT` for another store, takes both keys or neither (neither uses the AWS SDK's own
  credentials), and refuses to start otherwise, saying which setting is missing. The self-host
  compose stack sets every one of them, so it is unaffected.
* **self-host:** the hidden `supatype self-host native` commands (`install-service`, `serve`,
  `reload`, `status`, `logs`, `backup`) are removed. They were undocumented and untested, and
  `serve` ran the server's built-in object store, which applies no storage read rules: anyone with
  the anon key could read a private bucket. The systemd units `install-service` wrote started no
  storage service either. Docker Compose (`supatype self-host compose`) is the self-host path; back
  up a Compose stack with `pg_dump` against `DATABASE_URL`.
* **push, diff, seed and every command that reaches the local stack:** these commands no longer
  start the local stack. On a Docker project with the stack stopped, `push`, `diff`, `adopt`,
  `doctor`, `seed`, `migrate`, `migrations list`, `rollback`, `reset`, `introspect`, `pull` and
  `admin` refuse before doing anything: "The local stack isn't running. Start it with
  `supatype dev`, or `supatype self-host compose up -d` on a server, then run `supatype push`
  again." (naming the command run). `seed` exits 2, the others 1. `push` used to start Postgres,
  apply, then start the rest of the stack, and `diff` started Postgres and stopped it again. A
  linked project, `--connection`, `connection` in the config and an external database are reached
  as before, and a running stack behaves as before.
* **cache, functions:** `cache rest list`, `get`, `delete` and `flush`, and a local `functions invoke`
  that no `functions serve` answers, refuse on a Docker project whose local stack is not running,
  with the same message as `push` and the other commands that need the stack, naming the command
  run, and exit 1. They reached the stopped stack's API and failed with `Cannot reach` or a
  missing `SERVICE_ROLE_KEY`. An API address named by `SUPATYPE_URL` or `SUPATYPE_API_URL` in
  `.env`, a linked project's `functions invoke`, and a native project are unaffected.
* **schema:** a `?` on a model field (`due?: string`) is refused, naming `Model.field` and saying to
  write `Optional<>`. It read as nullable but compiled to a `NOT NULL` column.
* **generate:** `supatype generate --connection` is refused as an unknown option. Generate writes the
  types from the schema file and never opened a database, so the option was accepted and ignored.
* **seed:** a seed file's `export const config = { transaction: ... }` is refused, and `transaction`
  is gone from `SeedConfig`. It was validated and never sent: every seed file runs in a transaction
  of its own (all of them in one with `--atomic`), and the engine cannot run one outside it. Any
  other key `config` does not have (a misspelt `runonce`, say) is refused too, rather than ignored.
* **realtime:** the service's process entry is `dist/main.js`; `dist/index.js` only exports and no
  longer starts a server, so an `overrides.realtime` naming `packages/realtime/dist/index.js` exits
  at once. Point it at `packages/realtime/dist/main.js`.
* **hooks:** `AfterDeleteContext` has no `filter`. After-hooks are fed from the database's change log,
  which records the rows a write changed rather than the request that changed them, so there is no
  filter to give. `ctx.old` replaces it: the deleted rows themselves, as they were. A handler reading
  `ctx.filter` in an `afterDelete` no longer compiles; read `ctx.old` instead.

### Features

* **storage:** single-bucket S3 mode, as Supabase Storage does with `GLOBAL_S3_BUCKET`. Set
  `S3_BUCKET` and every Supatype bucket is a key prefix inside that one S3 bucket. The service never
  creates an S3 bucket or puts a bucket policy, the S3 bucket stays private, and the keys need only
  read, write, list and delete on it. Without `S3_BUCKET`, each Supatype bucket still gets an S3
  bucket of its own, now named `S3_BUCKET_PREFIX` then the bucket's id. A bucket's `s3BucketPolicy`
  is never applied in single-bucket mode, since it would cover every bucket at once. The storage
  service refuses it with 400 on a bucket made or changed through its API.
* **self-host, dev, init:** `storage: { production: "s3" }` in supatype.config.ts (init writes it
  from its "Production storage?" answer) makes `self-host compose` run the storage service against
  your own S3 bucket, with no SeaweedFS in the stack. Native `dev` with `storage: { provider: "s3" }`
  runs the storage service against the bucket in `.env`, so access rules apply there too.
* **auth:** `auth.email.enabled: false` in supatype.config.ts turns email-and-password sign-up and
  sign-in off (with magic links and password recovery) on native dev, Docker dev and self-host; a
  `SUPATYPE_EXTERNAL_EMAIL_ENABLED` in `.env` wins. Studio's auth Configuration page names the key
  for it and for email confirmation.
* **auth:** SAML single sign-on can be turned on from the config: `auth: { sso: { saml: { enabled: true } } }`,
  with optional `allowEncryptedAssertions`, `relayStateValidity` (seconds), `rateLimitAssertion`
  (assertions per 5 minutes) and `externalUrl`. `dev`, native `dev` and `self-host compose` pass the
  `SUPATYPE_SAML_*` settings to the auth server, a `.env` value winning over each, and nothing while
  SAML is off. The service provider's signing key is generated into `.env` as
  `SUPATYPE_SAML_PRIVATE_KEY` (RSA 2048) the first time SAML is on and never replaced, since a new
  key breaks every identity provider that trusts the old certificate. The compose file requires it
  from `.env` and never holds it. A key written into the config is refused.
* **sso:** `supatype sso add <name>`, `list`, `show`, `update` and `remove` register SAML identity
  providers (metadata URL or file, email domains, attribute mapping, NameID format) through the auth
  server's admin API, on the local stack or a linked self-hosted deployment. A provider is addressed
  by its name, stored as `resource_id`, and `update` changes it in place: deleting and adding a
  provider again would leave every user who signed in through it without a way back in. `update`
  keeps the NameID format unless told to change it. `add` warns when SAML is off.
* **sso:** `supatype sso info` prints the values an identity provider asks for: entity ID and
  metadata URL, ACS URL, NameID formats, the `subject-id` attribute preferred to the NameID, and a
  link to download the metadata XML.
* **sso:** `supatype sso rotate-key` writes `SUPATYPE_SAML_NEXT_PRIVATE_KEY` into `.env`, which the
  server publishes beside the current key while identity providers take the new certificate;
  `supatype sso rotate-key --promote` then makes it the current key, after saying what stops working
  for an identity provider that has not updated. For a linked deployment it prints the steps to take
  on the server.
* **sso:** `supatype sso verify-domain <name> <domain>` proves the project owns one of a provider's
  domains: it prints the DNS TXT record to add (`_supatype-challenge.<domain>` and its token), asks
  the auth server to check it, and says whether the domain is verified or what DNS answered instead,
  exiting 1 until it is. Running it again checks again. `sso show` and `sso list` mark each domain
  verified or not. On a dev stack a domain ending in `.supatype.test` counts as verified with no DNS
  lookup.
* **self-host:** `supatype self-host compose up -d` creates the storage buckets the schema declares
  and the first admin user once the stack answers, as `supatype dev` and a push to a running stack
  do. A push no longer starts a stopped stack, so nothing else would have made them. A failure there
  is a warning: the stack is up.
* **init:** a static app's `index.html` (and the page Vite builds it from) loads
  `<script src="/supatype-env.js" vite-ignore></script>` in its head, so the built site takes the address and
  anon key of whichever deployment serves it. Only where the committed config serves the app's
  files; a proxied app's page is left as it was.
* **init:** in a Next.js App Router app, init writes `app/supatype-env.js/route.ts` (or under
  `src/app`, and `route.js` without a `tsconfig.json`), which serves `/supatype-env.js` from
  `@supatype/ssr/next` with the running server's `SUPATYPE_URL` and `SUPATYPE_ANON_KEY`, adds
  `@supatype/ssr` to the app's dependencies, and loads the script first in the root layout's
  `<body>` with `next/script`'s `beforeInteractive`. One `next build` then runs against any
  deployment. A route or layout that already has it is left alone; a layout init cannot edit
  safely (no single `<body>`, or a `Script` that is not `next/script`) is left as it is, and the two
  lines to add are printed. A Pages Router app gets nothing written and the steps printed. A static
  export (`output: "export"` in `next.config`, read as text) gets neither the route nor the script,
  since `next build` cannot export a dynamic route; init says to build it with
  `supatype build -- next build`, or to let Supatype hosting serve it.
* **dev, init, keys:** a local stack's values in `.env.development.local` now include
  `SUPATYPE_URL` and `SUPATYPE_ANON_KEY` beside the frontend copies, so a Next.js app's
  `/supatype-env.js` route and its server client find them in `next dev` instead of refusing with 503.
  A deployment's values in `.env` still get only the frontend names. The CLI never loads
  `.env.development.local` into its own environment, so `supatype build` does not take these as
  values the host set.
* **client:** the generated client takes `url` and `anonKey` as `string | undefined` and, for one
  missing, reads the page's `window.__SUPATYPE_ENV__` at its first request; with neither, that
  request throws naming the variables to set, `supatype build` and the Next.js route, instead of
  sending requests the gateway refuses. Creating the client never throws, so `next build` can
  prerender a page that creates one at module scope.
* **diff:** every `supatype diff` ends with what `anon` (signed out) and `authenticated` (signed
  in) may do on each model's table once the push applies, one line per table (`question   read`,
  `profile    none`). A line the push changes shows what it is now as well
  (`question   none -> read`). The engine grants `anon` a privilege only where it can prove the rule
  needs no login, so a rule meant to be public that leaves signed-out callers with `401 42501` is
  seen before the push (issue 16). Printed also when there are no changes; an engine older than the
  summary prints no block. Many-to-many junction tables are listed too, as `post_tags (link)`, and
  a link whose end reads it through its own read rule says what it denies and why
  (`none   (read denied: an end's read rule reads this link table)`).

* **push:** prints the same access block before it applies or asks to confirm, in a terminal and
  with `--yes` alike.

* **dev:** after a push applies, prints the access lines it changed (`question   none -> read`),
  and nothing when no line changed.

* **push:** `--run-hooks` fires after-hooks for the rows a push's own data migrations rewrite (column
  conversions, block moves, kind changes). Without it they are skipped, as seeds are. Against an
  engine whose capabilities do not list `run_hooks`, the push stops before anything is sent.

* **init:** `supatype init <dir> --example <name>` starts from `examples/<name>` of the release
  matching the CLI (`v<version>` on GitHub), with every `workspace:` dependency pinned to
  `^<version>`. An unknown name is refused with the list of examples in that release, and so is an
  example holding a file named with `..`, a backslash, a NUL, a leading drive (`C:`) or an absolute
  path, or one that resolves outside the directory; nothing is written then. A colon anywhere in a
  name is refused too, since on Windows `docs/a:b.md` writes a hidden stream of a file `docs/a`.
  Such a name elsewhere in the repository does not stop an example. Schema snapshots are restored
  with the same checks, and `push` refuses a schema file named in a way restore would refuse.
  `supatype dev` warns instead and pushes without a snapshot, so it does not stop on every save.
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
* **build:** `supatype build [--env <name>] [--allow-local] [-- <command...>]` runs the app's
  production build (the package.json `build` script through the project's package manager, or the
  command after `--`) with the deployment's API URL and anon key under every front-end name
  (`VITE_`, `PUBLIC_`, `NEXT_PUBLIC_`, `EXPO_PUBLIC_`). Each value comes from the first of: the
  environment (any of those names, or `SUPATYPE_URL` / `SUPATYPE_ANON_KEY`), so a host's own
  settings win; for the anon key alone, the `/supatype-env.json` of the server the environment's
  URL names, for CI that sets only the URL; the linked environment (Supatype Cloud's keys route, or
  a self-hosted server's `/supatype-env.json`); a `.env` recording a deployment
  (`PUBLIC_SUPATYPE_URL` or `API_EXTERNAL_URL`, and `ANON_KEY`). A server's address is fetched over
  HTTPS only, unless it is local. A 404 there is reported as the address switched off
  (`server.public_env: false`), and a 503 as a server not set up to publish its anon key, quoting
  its reason on one line with anything shaped like a JWT withheld. An anon key from the link, a server or `.env` goes into the build
  only when it is for the same deployment as the URL (compared by scheme, host and port, ignoring a
  trailing slash and `/auth/v1`); otherwise the refusal says whose it is. The build does not start when either is missing, or when the address is local
  unless `--allow-local` is passed, and the refusal lists every source it tried. Nothing is written
  to a file, the service role key is never given to the build, and the exit code is the build's
  own. A bare `supatype build` run from inside one (a package.json `"build": "supatype build"`) is
  refused rather than running the build script again without end; a command after `--` still runs.
* **keys:** `supatype keys --print frontend [--env <name>] [--allow-local]` prints those same
  front-end names and values as `NAME=value` lines, and nothing else on stdout, for a host's
  settings or `$GITHUB_ENV`. Bare `--print` still prints the key pair. An unknown target is refused,
  listing the valid ones, and `--env` or `--allow-local` without `--print frontend` is refused.
  `keys --help` states the `--exp-years` default once.
* **config:** `server.public_env: false` renders `SUPATYPE_PUBLIC_ENV=false` into the server (self-host
  and dev compose, and native dev), turning off its `/supatype-env.json` and `/supatype-env.js` for
  an API-only project. Absent, the server's default (on) applies. A value that is not a boolean is
  refused.
* **init:** the "When you're ready to deploy" steps build the app with `supatype build --env
  production` once the deployment is linked, for Supatype Cloud and self-host.

### Bug Fixes

* **dev:** a Vite app started by `supatype dev` now listens on the address and port the app proxy forwards
  to (`--host 127.0.0.1 --port <upstream port> --strictPort`), and keeps its script's own flags. On Windows,
  Vite listened on [::1] while the proxy dialled 127.0.0.1, so the App URL answered 502 or showed another
  project's app. `init` now checks the Vite port is free on both loopbacks and offers the next free one.
* **dev:** before starting your app, `dev` now ends only a leftover process of this project's own. Another
  program on the app's port is left running, and dev says `port 5173 is used by another program (pid X)`
  instead of starting the app. Two projects on one port used to end each other's dev server every few
  seconds, which showed as the app exiting with code 1 and no error.
* **dev and every command that checks Docker:** a Docker that is running but slow to answer is now
  waited for, up to 60 seconds, with a "Waiting for Docker to answer" line, instead of being reported
  as not running after 10 seconds. `SUPATYPE_DOCKER_TIMEOUT` changes the wait. A Docker that refuses
  the connection or is paused still fails at once.
* **dev:** the "Services running" panel no longer prints the Postgres password or the full
  service_role key, so neither lands in CI logs. The database URL is masked as `status` masks it,
  and the key is shown as a fingerprint pointing at `SERVICE_ROLE_KEY` in `.env`. Native dev now
  fills a blank or missing `SERVICE_ROLE_KEY` in `.env` with the key the stack runs with, as Docker
  dev does, and never replaces one you set.
* **generate:** the client's types now include the columns the engine adds for `timestamps: true` and
  `softDelete: true` (`created_at`, `updated_at`, `deleted_at`), filled by the database and so
  optional on insert, so selecting `updated_at` no longer fails `tsc`. Hook row types include them too.
* **schema:** `WithPublishable<{ ... }>` now adds the nullable `published_at` column, as
  `{ ... } & Publishable` already did. The wrapper used to drop it, so the two spellings of one type
  built different tables. A `published_at` the model declares itself keeps its own shape.
* **client:** `single()` on a write no longer declares a `count` it never reads, so the client source
  compiles under `noUnusedLocals`. The package now checks that flag itself.
* **client:** `.range()` now sends `offset` and `limit` like supabase-js, so `.limit(n).range(a, b)` and
  `useQuery(..., { limit, offset })` no longer fail with 416, and a cached read of one page is no longer
  served for another page. Whichever of `limit()` and `range()` is called last sets the page size.
* **vue, svelte, solid:** query options can be a ref or getter (Vue), a store (Svelte) or an accessor
  (Solid), and the query runs again when they change. Before, sort, page and filter were read once.
* **react:** `useQuery` with an `offset` and no `limit` reads a page of 100 rows, as the Vue, Svelte
  and Solid queries do, instead of ignoring the offset.
* **push:** a push to the Docker stack whose step after the schema fails (starting the stack, waiting
  for the gateway, creating a bucket) now says the schema was applied but the push did not finish,
  prints no success line, and exits 1, as native and linked pushes do. It printed "Schema pushed."
  and exited 0, so pipelines passed with buckets missing (#301).
* **push:** a push with no `SUPATYPE_KONG_PORT` in `.env` no longer waits 120 seconds on the wrong
  port. It took the project's own running gateway on 18473 for another program's, moved to 18481
  where nothing listened, and silently skipped creating buckets.
* **schema:** a bucket's `s3BucketPolicy` that is not a JSON object is refused when the schema is
  read, naming the bucket. A push writes the bucket through the engine, so the storage service's own
  check never saw it and the bad policy was stored without being applied.
* **dev:** native dev no longer falls back to the server's built-in object store when the storage
  service does not start. That store applied no storage read rules, so any token, the anon key
  included, could read or sign any object in a private bucket. Storage is now off instead:
  `/storage/v1` answers 503 "storage service is not running", dev says why and how to fix it, and
  the stored files come back on the next start.
* **cli:** the npm package now installs on Node.js 18 and later, not only 22, and an older Node is
  told which version to install. 0.8.0 to 0.9.1 asked for Node 22, which the package never needed,
  so npm on Node 18 or 20 quietly installed 0.7.0 instead of the latest release.
* **self-host:** a self-hosted stack now sends a confirmation link with every new email sign-up
  unless `auth.email.enableConfirmations` is `false`; it used to confirm every sign-up at once, so
  anyone could sign up with an address they do not own. Local dev still confirms at once.
* **auth:** the CLI no longer writes `SUPATYPE_MAILER_AUTOCONFIRM` into `.env`, so a value you set
  there and restart with is kept, as the auth docs say; before, every start rewrote it from the
  config. The line an earlier CLI wrote is taken out once, with a message saying so, and `init`
  marks new projects so their own line is never taken out.
* **examples:** kitchen-sink, supabucks, framework-parity and expo-auth's web export run from a
  plain `vite build` / `expo export` again: the page loads `/supatype-env.js` and the client reads
  the anon key from it, so a build no longer shows a blank page after `dev` or `keys`, and never
  ships the local stack's key. Each example's `.gitignore` now ignores `.env.*.local`.
* **keys:** an anon key written with no API URL in `.env` goes to `.env.development.local`, not
  `.env`, so a plain production build no longer bakes the local stack's key.
* **realtime:** realtime no longer makes Postgres log six lines every 100 ms while nothing is
  changing. It reads the replication slot only once the WAL has moved past it, so an idle stack
  stopped writing about 0.8 GB of database log a day.
* **self-host:** every container in the self-host and Docker dev compose file now rotates its log
  (json-file, 10 MB x 5 files), so a Linux server's disk no longer fills with container logs. Set
  `SUPATYPE_LOG_MAX_SIZE` and `SUPATYPE_LOG_MAX_FILE` in `.env` to change the sizes.
* **gateway:** Docker dev and self-host now answer 400 to an API or Studio request whose path has an
  empty, `.` or `..` part (`%2E` too), as native does. Kong used to resolve these first, so `x/../a`
  wrote the storage object `a` and `/studio/../auth/v1/...` reached auth. Your app's own paths are
  not checked and reach it as before.
* **client:** `createClient` drops a trailing `/` from its URL, so `https://api.example.com/` no
  longer builds `//rest/v1/...`, which the gateway now refuses and native never routed.
* **storage:** a private bucket no longer tells a caller its read rule refuses which file names
  exist: download, authenticated download and signing answer 403 for a missing name exactly as for
  one that exists, where they used to answer 404 "Object not found" for a missing name. A caller the
  rule lets read the name still gets 404 for one that is not there.
* **init, generate:** the Next.js `/supatype-env.js` route works on a new create-next-app. Next 16
  turns on `cacheComponents`, which refuses the route's `export const dynamic` with a 500; the route
  is now only `export { GET } from "@supatype/ssr/next"`, and `GET` reads the request, which keeps it
  rendered per request (not prerendered with the build machine's values) on Next 14, 15 and 16.
  `supatype generate`, which `prepare` runs on install, replaces a route 0.9.1 wrote while it is
  unchanged, warns about a changed one that still has the line, and warns when the installed
  `@supatype/ssr` is older than 0.9.2. The docs' server helper awaits `connection()`, so Next 16 no
  longer logs a `Date.now()` prerender error, and says where to put it with or without `src/`.
* **realtime:** `channel(name).on("postgres_changes", { table })` and `useSubscription` now watch
  the `public` schema when no `schema` is given, as the docs say. A channel name with a colon, such
  as `post:42`, was read as `schema:table` even when the listener named its table, so the
  subscription reported SUBSCRIBED and delivered nothing. The realtime server reads a subscribe
  message the same way. The name is still read as `schema:table` when no table is given.
* **react:** `useQuery`'s `refetch`, `useAuth`'s sign-in and sign-out methods, and
  `usePasswordRecovery`'s `finish` now keep the same identity across renders, so an effect can list
  them as dependencies. A new function on every render made `useEffect(() => refetch(), [refetch])`
  loop, sending thousands of requests a second and ending in "Maximum update depth exceeded".
* **init, dev:** `supatype dev` no longer starts itself as the app. In 0.9.1, `init` with "Local dev
  server" and the script prompt left at its default wrote `app.start: "dev"`, and in a new folder
  `dev` is init's own `supatype dev`, so dev ran a second copy in its app pane that failed and was
  restarted for ever. `init` now asks about Vite first: a Vite app runs the `vite` script at Vite's
  URL, with nothing more to ask. Without Vite it offers the project's own `dev` or `start`, never one
  that runs `supatype dev`, and refuses any script that runs it. `dev` refuses such a script too, saying to
  set `app.start`, so a project 0.9.1 made needs only that one edit. A `supatype dev` reached some
  other way (`npm run supatype:dev`, `concurrently`) stops at once with the same advice, and the app
  pane leaves it stopped.
* **dev:** a service that keeps crashing as it starts is no longer restarted every 30 seconds for
  ever. After 5 crashes in a row, each within 5 seconds of its start, dev says so once and retries
  less often, the wait doubling past 30 seconds, so a fix to what it needs is still picked up. Once
  the wait would reach 5 minutes, about 8 minutes in, dev leaves it stopped and says to fix the
  error and restart `supatype dev`. This covers the app, Studio, and on a native project the server,
  PostgREST, realtime and storage. Realtime stopped this way is switched off at the gateway, as it
  already was after a clean exit. A run that lasts longer starts the count over, and the wait
  before the next restart goes back to 1 second instead of staying at the longest it reached.

* **dev:** a save made by writing another file and renaming it over the schema is pushed. `sed -i`
  saves were always missed on Linux, and an editor's safe write or a script's `mv` about one time in
  three: the event named only the other file, which the watch ignored, so the database kept the old
  schema and nothing said so. Any event in the schema folder now leads to a check of the schema
  itself.
* **init, self-host compose, dev:** every project gets its own object-store login, generated into
  `.env` as `SUPATYPE_OBJECT_STORE_ACCESS_KEY` and `SUPATYPE_OBJECT_STORE_SECRET_KEY`, and the compose
  file reads it from there. Every stack shared the published pair `supatype` / `supatype-secret`,
  which opens every file in every bucket past the bucket rules to anything that can reach port 8333.
  A project still on that pair gets a new one on its next `dev` or `self-host compose up`; stored
  files are kept.
* **self-host compose up and restart:** the mailer settings come from the committed config. `dev`
  wrote them into `.env` from the config with `supatype.local.config.ts` over it, so production
  started with dev's mail catcher as its SMTP host, and with dev's last autoconfirm after the config
  turned email confirmations on. Values the CLI writes from the config are marked as its own and taken
  out when the config stops giving them; a value written by hand is left.
* **init:** choosing SMTP asks for the host and port. `dev` and `self-host compose up` warn when the
  provider is SMTP and no host is set, which made the server drop every email without a word.
* **functions new, functions env set:** `functions env set` in a project with no `functions/` folder
  creates it, where it said "Setting FOO" and then failed with ENOENT. `init`, `functions new` and
  `env set` create `functions/.env.local` the same way.
* **status:** on the local stack, the stack's services are listed after its functions, and `_shared`
  is no longer listed as a function. The database line is the address a program on this machine
  connects to, with the password shown as `***`, as `seed --status` shows it.
* **self-host compose up, every command in a terminal:** docker's output no longer goes straight to
  the terminal while a command's screen is up. It landed in the screen being redrawn, and the notices
  above it came out twice. It is kept and shown when docker fails, and what docker prints as its
  answer, `ps`'s table say, goes into the command's log.
* **push, every command in a terminal:** a spinner's line stays above the lines its work logs.
  `push` printed "Schema pushed." above "Applying schema via Docker Compose".
* **init:** the closing list of the secrets it generated names the object store's login.
* **login:** the saved Cloud session is created readable by its owner alone (600). It holds the
  session's tokens. A project's `.env` is not: the stack's containers read it as another user, and an
  owner-only `.env` stopped the server starting on a Linux host.
* **migrations list:** a push by an OS user with no git name says "(unverified)" once. The recorded
  author now reads `nic (OS user)`, and the list adds whether it was verified.
* **every command in a terminal:** what a command logged stays on screen when it ends, once. The
  command's chrome was cleared at the end and a short report went with it: `seed --status` showed
  nothing in a terminal, only when piped. The last frame is now just the logged lines, and it is left
  on screen.
* **every command in a terminal:** a command that fails and exits shows why. `types check` in a
  project with no `tsconfig.json` printed its banner and exited 1 with no message, because the
  process ended before the message was drawn.
* **every text prompt:** a pasted line that ends in a line break is submitted, where the break was
  kept in the answer and drawn raw over the prompt's border. Backspaces sent in one burst erase.
* **reset:** drops the managed tables, applies the schema to the empty tables and runs the seeds
  again, which `--no-seed` skips. It printed "Reset complete." and changed nothing: it pushed the
  schema the database already had. Sign-ins, stored files, Studio members and SSO providers are kept;
  `dev --reset-db` still wipes the whole database.
* **migrate, reset, rollback, migrations list, rename --prune, pull, deploy --local:** on the local
  stack's own database these run the project's engine image, as `push`, `diff` and `seed` do. They
  ran the engine binary cached on this machine, so with an engine image chosen, `migrate` wrote SQL
  from the released engine that `push` no longer ran. A `--connection` to another database still
  runs the binary here.
* **seed:** `supatype seed` and `npm run seed` work from the standalone binary on Windows. Every
  seed file failed with "Cannot find module 'B:\~BUN\root\seed-ir.js'": the seed ran from a temp
  file that could not import the CLI's own modules out of the binary. The binary now collects a
  seed by running itself, as it already does to read the config. It also resolves packages from the
  project's node_modules, which it could not do at all, so a seed builder's `@supatype/cli/seed`
  import is found.
* **init:** a Kong port typed that another running Supatype stack holds gets one reason at every
  prompt, "Port N is in use by another Supatype stack configured with it.". The first prompt said
  it was configured for another stack and the next said it was in use on this machine.
* **envs:** `envs list` says when the default environment is not linked, and how to link it:
  "Default: production (from supatype.config.ts environments, not linked: run supatype link --env
  production)". No environment was starred and nothing said why.
* **sso:** `supatype sso info` prints the signing certificate from the server's own metadata. It
  said "it lists no certificate" because it only read a `<X509Certificate>` with nothing after the
  name, and the server writes `<X509Certificate xmlns="...">`.
* **init:** the reasons around the Kong port prompt can be read. A port typed that is in use is
  asked for again with the reason above the question, and a port only a stopped Supatype stack is
  configured with is taken only after a yes to "Use it anyway?". Both were logged between prompts,
  and the next prompt's redraw wiped them before anyone could read them.
* **self-host:** `supatype self-host compose up` checks the ports the stack publishes before it
  starts anything, and names the port, the service and how to see what holds it. Docker used to fail
  on the port after starting some containers. A stack whose gateway never answers is now reported as
  "started but is not serving", with exit 1; it said "The stack is up" and exited 0.
* **envs:** `supatype envs list` names the default commands actually use, and says when it comes
  from `environments` in supatype.config.ts, which wins over `envs use`. `envs use` says so too when
  the config names another environment, rather than "Default environment set". A command refused for
  an environment that is not linked says when the config named it.
* **pull:** `supatype pull` no longer hangs at "Introspecting database...". The engine reads its
  input from stdin when it is not given an input file, `introspect` is given none, and the CLI left
  the engine's stdin open with nothing written to it. Every program the CLI runs for its output,
  the host engine and each `docker` call (so the engine run by `compose run`), now gets a closed
  stdin after any input it is sent.
* **adopt, doctor, pull and every command that reaches the local stack's database:** on a running
  stack whose `db` container was stopped on its own, these refuse with the "local stack isn't
  running" message, as `diff` and `push` do, and leave it stopped. `adopt` and `doctor` ran the
  engine with `docker compose run`, which started `db` as its dependency, so `adopt` answered
  "Nothing to adopt" with the database running again; `pull` went on to the stopped database and
  printed nothing.
* **db check:** `supatype db check` in a project reads DATABASE_URL from the project's `.env`, as
  every other command does; with only `.env` naming the database it said "No connection". It is for
  a Postgres the project does not run, so a stopped local stack is no reason to refuse it. A refused
  connection names the address it tried, never the password, and says to check that the database
  is running and that the source of the URL names the right host and port; it printed only
  `connect ECONNREFUSED 127.0.0.1:54329`. The `push` check of a database Supatype does not run,
  and `doctor`'s after-hooks check, say it the same way.
* **dev:** on Windows, `supatype dev` no longer stops itself two seconds after starting in a shell
  whose own parent had already exited (a window opened by `Start-Process`, by `start` from a script,
  or by a terminal launcher that exits). It watches the shell's parent too, and counted one that was
  gone from the start as the process that started dev exiting. Only an ancestor alive when dev
  started counts now, so dev still stops when the script or agent that started it is killed.
* **dev:** the dashboard's `supatype` pane shows what a save did, as `dev --stream` prints it: the
  change detected, applied or failed (with its hints), the access lines the save changed, and the
  generated files written. It stayed at "Services running." through every save: the renderer took
  the console over once the dashboard was drawn, and the pane's filter dropped the access lines
  besides.

* **dev, push:** a stack service that exits while the CLI waits for the API gateway stops the wait.
  With the server container exited on a fatal config error, `supatype dev` sat at `Waiting for API
  gateway...` for 120 s, failed naming the gateway's health, and then removed the containers, so
  the server's log was gone. The wait now watches `db`, `kong`, `server`, `realtime` and `storage`:
  once one has exited it says which, with its exit code, and prints its last 30 log lines with the
  project's secrets from `.env` and any connection string's password replaced by `***`, before the
  stack is taken down. Either failure now ends dev's dashboard before printing, so what it prints
  reaches the terminal.
* **init:** the admin email must be one address (an `@`, no spaces), and no answer init asks for,
  typed or given as `--admin-email` or `--admin-password`, may hold a line break or other control
  character. A pasted email with carriage returns in it went into `.env` as it was, so the server
  read each piece as a line of its own, refused to start, and printed the lines that followed in its
  log, the admin password among them. Init now refuses it before writing any file.
* **env files:** no command writes a value with a line break or other control character into `.env`,
  `.env.development.local` or the functions' `.env.local`. It is refused, naming the key and the file
  and never the value, and the file is left as it was.
* **init:** the runtime env script init puts in `index.html` carries `vite-ignore`, so `vite build`
  no longer warns, on every build, `<script src="/supatype-env.js"> in "/index.html" can't be
  bundled without type="module" attribute`. Vite leaves the tag in the built page, without the
  attribute, and it still runs before the app's own script. A page init wrote before keeps its tag
  and its warning until `vite-ignore` is added by hand.
* **build:** a server that answers 404 at `/supatype-env.json` is reported as having
  `server.public_env` set to false or running a release too old to serve it, in place of "or is
  older than the address".
* **dev, push, self-host:** a project that does not pin its own versions now runs schema-engine
  v0.9.0 and server v2.3.0. The 0.9.0 CLI shipped still pinned to engine v0.8.0 and server v2.2.2,
  so it missed four fixes those releases carry. An access rule built on
  `In<"col", Rows<"table", "id", Where>>` with a login-free `Where` now grants `anon` the privilege
  its policy needs, where an anonymous read or insert answered `401 42501 permission denied`.
  `Default<JSON<string[]>, "[]">` now gives the column its default, where it created `jsonb NOT
  NULL` with none and an insert that left it out failed with `23502`. A missing file with an
  extension, such as `/assets/missing-abc.js`, answers `404`, not the app's `index.html` with
  `200 text/html`. A signup with a password but no email or phone answers `400 validation_failed`,
  not `anonymous_provider_disabled`, and never creates an anonymous user that drops the password.
  The next push on an existing project adds the missing grants and defaults.
* **dev, init, keys:** the front end's copies of the API address and the anon key
  (`VITE_SUPATYPE_URL`, `VITE_SUPATYPE_ANON_KEY` and their `PUBLIC_`, `NEXT_PUBLIC_` and
  `EXPO_PUBLIC_` twins) for a local stack are written to `.env.development.local`, not `.env` or
  `.env.local`, and removed from those two files. A production build read the local stack's
  `http://localhost:<port>` address and key from `.env` and shipped them. A production build now
  reads no anon key unless one is set for it: `supatype keys` writes the copies to `.env` only when
  `.env` records a non-local `PUBLIC_SUPATYPE_URL` or `API_EXTERNAL_URL`, and `self-host compose
  up` writes only `ANON_KEY` and `SERVICE_ROLE_KEY`. Shipped in 0.9.0 without an entry here.
* **init:** the `.gitignore` init writes no longer ignores `src/lib/supatype.ts` or
  `src/types/supatype.d.ts`. Nothing has generated either path for some time, and apps write their
  own client to `src/lib/supatype.ts`, so a commit left the client out without a word and a fresh
  clone did not build. A project made by an earlier init still has the two lines under
  `# Generated by supatype push (legacy paths...)`; delete them and `git add` the client.
* **diff:** `supatype diff` and `supatype push` against a local stack that is not running say
  `Could not connect to http://localhost:<port>/platform/v1/...: connection refused. The local stack
  is not running: start it with supatype dev, then run this again.` The compiled CLI said only
  `Unable to connect. Is the computer able to access the url?` and the npm one `fetch failed`,
  naming neither the address nor the fix. A linked server that refuses the connection is named the
  same way, without the `supatype dev` advice. `supatype functions invoke` says `Cannot reach <url>`
  under the compiled CLI too; it printed Bun's words instead.
* **dev:** stopping `supatype dev` no longer says `Docker is installed but the daemon is not
  running` while Docker is up. The shutdown's `docker compose down` first asked the daemon whether
  it was running, giving `docker info` 15 s; a Docker busy enough to be slower than that was
  reported as stopped, and dev exited before `down` ran, leaving the exit hook's fallback to stop
  the stack. Stopping a stack that was just running no longer asks: `down` runs at once, and says
  so itself if Docker really is gone.
* **diff, push, dev, self-host:** a Docker that is slow to answer is no longer reported as not
  running. `supatype diff`, straight after one that failed on a port clash, said `Docker is
  installed but the daemon is not running` with `Docker did not answer within 15s`, while `docker
  info` answered in under a second. A check that times out is now asked once more, and if Docker is
  still silent the CLI says `Docker did not answer in time` and that it may be busy. "Not running"
  is said only when the docker CLI reports it cannot connect; a paused Docker Desktop is called
  paused, and any other `docker info` failure is shown as Docker printed it.
* **dev:** a proxy app whose start script is `vite` starts again. The compiled program ran
  `vite.js` with itself rather than Node, so the app task exited with `error: unknown command
  '<app>/node_modules/vite/bin/vite.js'`, was restarted for the rest of the session, and every app
  route answered 502. `vite.js` for the app and for `overrides.studio`, and a `.js` entry named by
  `overrides.realtime` or `overrides.storage`, now run with the `node` on PATH; with none there,
  dev stops and says Node.js is needed. The dev log names the program it runs, where it used to
  say `node vite.js` whatever ran (#28).
* **generate:** a `JSON<T>` column is typed as its `T` again in the generated types, augmentation
  and client, as it was in 0.8.0. Since 0.9.0, npm runs the compiled CLI, which carried none of
  TypeScript's lib files, so the schema reader knew no `Array` or `Record`: `JSON<string[]>` was
  written as `{}` and `JSON<Record<string, number>>` as `Json`. The CLI now carries those files
  (#27).
* **dev:** the dashboard's `app` pane shows the proxy app's output whole. A line that reached the
  CLI in two reads was shown as two lines, a CRLF line kept its carriage return, and a line printed
  twice in a row was dropped the second time, so repeated request errors showed once. An app that
  crashed on every start showed its error after the first crash only, followed by nothing but
  `process exited ... restarting` lines: each restart's identical error was taken for a repeat of
  the run before. The same applies to Studio, realtime and the other processes dev runs, and to
  `--stream`, where each line is written once.

  Freeing the proxy app's port no longer freezes the dashboard. The port scan ran synchronously
  before the app's first start and before every restart, and on Windows it took over ten seconds,
  during which no process's output appeared. It now runs in the background, and the app is still
  spawned only once the stale listener is killed. The scan also matches only a listener on exactly
  the app's port: on Windows it also killed listeners on longer ports that started with the same
  digits (5285 matched 52851), and on macOS and Linux it killed every process connected to the
  port, a browser on the dev server included.
* **deploy:** the app's build is given the deployment's anon key, through the resolver `supatype
  build` uses. It got the URL copies only, and those from the control plane's address rather than
  the project's, so a deployed app rendered a blank page. A deploy whose build would get no URL or
  anon key now stops before building, listing what it tried (`--allow-local` takes a local
  address). The install and build steps run through cmd.exe on Windows, where `npm` and `pnpm` could
  not be started without it.

* **init, dev:** Windows no longer asks to let `supatype` through its firewall. Checking whether a
  port was free bound it on every address (`0.0.0.0`), which Windows treats as a program wanting
  network access, and it remembers the answer per program file, so it asked again after every CLI
  upgrade. The check now binds loopback only and connects to the port, which still finds a
  listener on every address, the kind Docker Compose publishes.
* **npm, install:** the compiled `supatype` program no longer reads `.env`, `.env.local`,
  `.env.development.local` or `bunfig.toml` from the directory it runs in. It loaded the project's
  files into its own environment, which the CLI under Node never did, so the project's
  `SERVICE_ROLE_KEY` sent `diff` and `push` to a local stack's API instead of its database, and a
  `bunfig.toml` `preload` ran its code inside the CLI. The CLI reads the files it needs itself.
* **dev:** saving the schema no longer freezes the dev dashboard while the push runs. The engine's
  push, its `parse` and `admin` runs, the compose engine run on a docker project, and the two `psql`
  calls a docker push makes after it (the `auth.users` grant and reading the field-masking tier)
  were all synchronous, so for as long as a push took no process's output appeared and the
  dashboard did not redraw. They now run in the background, and so does asking git who is
  pushing. Native dev also pushes one save at a time, as docker dev already did: a save made during
  a push is pushed once that push is done. Every command that runs the engine runs it the same
  way, with the same results and errors.

* **npm:** the CLI works in an app that installs React 19. npm hoisted the CLI's `ink` into the
  app's `node_modules`, where it loaded the app's React rather than the CLI's own React 18, and
  every command failed with `Cannot read properties of undefined (reading 'ReactCurrentOwner')`.
  So did `npm install`, through the scaffold's `prepare: supatype generate`. Installed from npm,
  `supatype` now runs the same signed program the curl and Homebrew installs run, which carries its
  own copy of everything it uses. The first run of each version downloads it from
  releases.supatype.com into `~/.supatype/cache/cli/<version>/`, checked against the release's
  signed checksums; set `SUPATYPE_CDN_BASE` to use a mirror. The package no longer installs `ink`,
  `react`, `commander`, `ts-morph`, `tsx` or `bcryptjs` into the app. Linux, macOS (x64, arm64)
  and Windows x64 are supported; anything else is refused with the list.
* **self-update:** run by the npm package, `self-update` says to update with npm instead of
  replacing the program the package starts.
* **cache:** upgrading an npm install leaves the previous version's program in the cache, since
  another project may still use it. Once those take more than 250 MB the CLI says so when it
  starts, at most once a day, and `supatype cache clean` (or `cache clean cli`) removes them,
  never the running version.
* **init:** new projects no longer install `tsx`. The CLI runs the project's TypeScript itself.
* **init:** a project installs for production. Its `prepare` ran `supatype generate`, which npm
  runs on `npm ci --omit=dev` too, where the CLI (a development dependency) is not installed, so
  every production install failed with `supatype: not found`. `prepare` is now
  `supatype-prepare`, a command `@supatype/client` installs, which runs `generate` only where the
  CLI is installed, as Prisma's client does with the Prisma CLI. A failing `generate` still fails
  the install. Existing projects `init` is merged into get the same script, and their
  `@supatype/client` is moved into `dependencies` and raised to a release that has the command.
  `init` never picks a client older than itself, and replaces the `prepare` earlier releases
  wrote. A project made before this release keeps that `prepare` until then: set it to
  `supatype-prepare`, and upgrade `@supatype/client` to this release, the first with that command,
  listed in `dependencies`.
* **dev:** a Ctrl+C sent to the npm package's process alone, as an IDE's stop button sends it, stops
  dev on Linux and macOS, where the starter passes every stop signal on. dev counts the same signal
  twice within half a second as one press, since a Ctrl+C typed in the terminal reaches it both
  from the terminal and from the starter; pressing again to force quit still does.
* **dev:** one Ctrl+C stops `supatype dev`. Ink took the first one itself and closed the dashboard
  and nothing else, so dev went on running with no screen until a second Ctrl+C.
* **dev:** the dashboard names what it is waiting on, with a spinner: starting Postgres, applying
  the schema, starting the services (the first start downloads their images), waiting for the
  gateway. It showed the logo over an idle log, sometimes for minutes. Starting the Compose stack
  no longer blocks the screen, so the spinner keeps turning while images download.
* **init:** a Vite app gets `vite: ^8`, which current `@vitejs/plugin-react` requires (`^6` failed
  the install with ERESOLVE), and a `build: vite build` script, without which nothing produced the
  `./dist` that `app.static_dir` serves. A new project's package.json has `"version": "0.1.0"`.
* **init:** `.env`'s `SITE_URL`, where auth emails send people back to, is the address a static or
  proxied app is served on (the gateway's port on Docker). It was `http://localhost:3000` for every
  project, where nothing listened.
* **init:** in an existing package.json, `@supatype/cli` and `@supatype/types` go in
  `devDependencies` as they do for a new project, and the `seed` script runs `supatype seed`. It ran
  `tsx seed.ts`, which loads the seed module without calling it.
* **functions serve:** a project with `functions/.env.local` serves again. The file was handed to
  Deno as `--env-file <path>`, two arguments, and Deno takes the value only after `=`, so it ran
  `.env.local` as the script and served nothing. `functions new` creates that file, so every project
  that had made a function with it was affected.
* **dev:** native dev's port-in-use message says which port to move ("Move this project's database
  port with ..."). It read "Move this project's with ...".
* **dev, functions serve, functions worker:** a function that fails to load answers its own route
  with a 500, `function_load_failed` and why, and every other function keeps serving. A module that
  threw on import, did not parse, or exported no handler stopped the router (or the deployed
  worker) starting, so every function answered 502.
* **dev:** native dev writes a bucket declared `custom` as not public in the object store's
  `buckets.json`. It copied `public: true` from the declaration, so the store listed a custom
  bucket as public, which the store and the storage service never do.
* **hooks:** the `beforeChange` scaffold from `supatype hooks new` no longer says the service role
  bypasses hooks. The server fires them for every write through the API, service-role key included;
  only direct SQL, seeds and migrations skip them.
* **dev:** a blank mailer setting in `.env` no longer erases the one `email` in `supatype.config.ts`
  sets. `init` scaffolds `SUPATYPE_SMTP_HOST=`, `SUPATYPE_RESEND_API_KEY=` and the rest blank, and
  native `dev` applied `.env` over the config, so a project with its SMTP host or Resend key in the
  config got the noop mailer and sent nothing. A value in `.env` still wins over the config.

* **app, status, functions serve:** the local gateway address follows `.env`. `app add` printed the
  app URL, `status` the API URL, and `functions serve` gave functions `SUPATYPE_URL`, all on the
  default port 18473 whatever `SUPATYPE_KONG_PORT` said, so after `dev` moved Kong to another port
  they pointed at whichever stack held 18473. They now use `.env`'s `API_EXTERNAL_URL`, else
  `SUPATYPE_KONG_PORT`, as `ctx.publicUrl` already did.

* **pull:** a uuid `id` column is drafted as `UUID`. Every one was drafted as `SupatypeAuthUserId`,
  which declares the key to be an auth user's id; telling the two apart needs the schema of a foreign
  key's table, which the engine does not report yet. A drafted model also names its table
  (`tableName`) when its model name would not map back to it, as `HTTPLog` or `Orders` do, so a push
  of the draft does not create a second, empty table.

* **plugins:** `plugins add` and `plugins list` no longer claim a plugin is in use. `add` said
  "installed and registered" and `list` showed every compatible plugin as "active", but nothing in
  Supatype loads plugins yet. Both now say the plugin is installed and that it is not loaded.

* **functions:** the scaffolded `functions/_shared/context.ts` says where `ctx.env` comes from: the
  functions directory's `.env.local` (or `SUPATYPE_SHARED_ENV_FILE`), then `.env.<function>.local`,
  which wins. It said `.env`, which is never read for it.

* **dev, functions serve:** the local functions router loads and guards handlers as the deployed
  worker does. It accepted only `export default`, so a function exporting a named `handler`, which the
  worker serves, failed to load locally; a module with neither answers its own route with an error
  naming it. It also gave every function the service-role key, in `ctx.serviceRoleKey` and in `Deno.env`, where the
  worker takes the key out of the environment before importing any handler and grants it only to the
  routes `functions.serviceRole` lists, and to hooks. The router now does the same, so a function that
  relies on the key without being listed fails locally rather than once deployed. The key is still
  granted after `--watch` reloads the router on a change, however the run before it ended: a function
  that failed to load, an unhandled rejection or a crash no longer leaves every later reload without
  the key until `dev` restarts. The router reads it from a file in `.supatype/`, readable by its owner
  only, rather than from the environment it takes the key out of. The file is removed when `dev` or
  `functions serve` stops, Ctrl+C included, and each `functions serve` has a file of its own.

* **dev, functions serve:** native `dev` and `functions serve` run the functions worker the deployed
  image runs (packages/functions-worker), not a router the CLI generated to copy its rules, so the
  two can no longer drift: the copy had already differed on which exports it took, who got the
  service-role key and which env files it read. The CLI carries the worker's source and writes it to
  `~/.supatype/cache/functions-worker/`. Native `dev` now also serves model hooks from `hooks/`, as
  the compose stack does, including in a project with hooks and no functions, and picks up a hook
  added while it runs; `functions serve` picks up a function added while it runs.

* **functions:** `ctx.env` reads `.env.local` and `.env.<function>.local` with the CLI's own dotenv
  parser, so `KEY="value"` is `value`, an inline ` # comment` is dropped and `export KEY=` is read,
  as the CLI and compose read a `.env`. The worker kept the quotes and the comment.

* **dev (native):** runs the storage service (packages/storage) on this machine instead of the
  server's built-in object store, so bucket rules, `maxSize`, `accept`, `access_mode`, caller rules
  and image transforms are the ones a deployment enforces. Its objects live under
  `~/.supatype/projects/<project>/storage-service/`; the first start imports the buckets and objects
  the server's store held, and each later start imports what changed there since, so what the
  server's store took while the service was down reaches it and an object deleted in the service
  stays deleted. An object the service refuses is skipped and named once. The old files stay for
  one release: the next CLI release removes them and says which, keeping and naming the objects the
  service refused. The service comes
  from a per-platform archive on the CDN (`storage/v<version>/`, signed like every component), or
  `overrides.storage`; its port is `SUPATYPE_STORAGE_PORT` (default 8002). When it cannot start, dev
  says so and the server's store answers as before.

* **self-host:** the compose stack serves functions from `functions.path`. The functions worker, the
  server and the control plane were all told `/project/functions` whatever the config said, so a
  project keeping its functions elsewhere had every one answer 404; hooks were likewise fixed at
  `/project/hooks` rather than following `supatype.root`. A `functions.path` or `supatype.root`
  outside the project directory is refused with a message saying why, since the stack mounts only
  the project. `functions deploy` names the real directory instead of a fixed `functions/`.

* **dev, self-host, init:** Resend and SES settings reach the auth server. Native `dev` sent them as
  `RESEND_API_KEY`, `RESEND_FROM` and `SES_FROM`, which the server does not read, docker `dev` sent
  none of them, and the self-host compose file had no way to pass them, so `email.provider: "resend"`
  or `"ses"` fell back to the noop mailer and sent nothing. All three now use
  `SUPATYPE_RESEND_API_KEY`, `SUPATYPE_RESEND_FROM` and `SUPATYPE_SES_FROM`, and the compose file
  passes them through from `.env`. `init` scaffolds the email settings under those names too, and
  SMTP's as `SUPATYPE_SMTP_*`; the unprefixed `SMTP_HOST` and the rest it used to write were never
  read either. Rename any of these already in a project's `.env`.

* **dev:** magic-link, confirmation, invite and recovery links in native `dev` open the auth
  server's verify endpoint. They pointed at `http://localhost:<port>/verify` and 404'd: the external
  URL ends in `/auth/v1`, and the server's default `/verify` replaced that path rather than adding to
  it. Native `dev` now sets the same `/auth/v1/verify` paths the compose file does.

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
* **self-host, dev:** storage has no quota and no per-file limit unless `.env` sets one.
  `STORAGE_QUOTA`, `TIER_MAX_UPLOAD_SIZE`, `MAX_UPLOAD_SIZE` (bytes, `-1` for unlimited, the
  default) and `PROJECT_TIER` now reach the storage service, which on its own applied the free
  tier's 1 GiB quota and 50 MB file limit to every self-hosted and local project.
* **dev, push, self-host:** `DATABASE_URL` follows a database port exported in the shell
  (`SUPATYPE_DEV_DB_PORT`, or `SUPATYPE_DB_PORT` for a self-host stack). Compose binds the shell's
  port, and the URL was reconciled against `.env` alone, so seeds and host-side commands reached a
  port nothing listened on. The shell's port is the run's: the URL changes for that run and `.env`
  keeps its own.
* **dev, self-host:** a project moved from native dev to Docker routes realtime and functions to the
  stack's own services. The compose render left native's `realtime_url` (a host port) in
  `.supatype/manifest.json`, so every realtime request answered 502.
* **dev:** native dev routes functions to the Deno the server runs. It kept the
  `functions-worker:8001` URL `init` writes for the compose stack, so every function answered 502
  with "lookup functions-worker: no such host".
* **dev:** native dev checks the port functions run on (8001, or `SUPATYPE_DENO_PORT`) before it
  starts, as it does Postgres, the server, PostgREST and realtime, and stops naming the variable
  that moves it. With the port taken, Deno failed after the stack was up and every function
  answered 502. The port checked is the port the server gets: an exported `SUPATYPE_DENO_PORT`,
  else the one in `.env.local` or `.env`, else 8001. A blank `SUPATYPE_DENO_PORT=` in `.env` leaves
  8001 rather than reaching the server as an empty port.
* **update:** `supatype update` exits 1 naming each component it could not fetch. A run where every
  download failed ended on "All components are up to date." with exit 0, and a pinned version was
  written into `supatype.config.ts` even when its download had failed.
* **init:** `supatype init` uses an exported `SUPATYPE_KONG_PORT` as the project's gateway port, in
  `.env` and in what it prints, and the wizard does not ask for one. It chose its own port, so `.env`
  and the "API on" line named a port the stack, which binds the shell's, never listened on.
* **push:** a Docker push that applied the schema exits 0 when a step after it fails on the running
  stack (its `up -d`, the gateway wait, the buckets or the first admin), warning `The schema was
  applied, but a step after it failed` with the reason. A start that failed on a port another
  program held made push exit 1 with the schema in.
* **push, diff, adopt, pull:** on a running stack these no longer run `docker compose up -d db`
  before they reach its database. Every layout already publishes Postgres on the port the host
  engine connects to, so the call had nothing to start, and could recreate the database container
  when its definition had changed; with `overrides.engine` on a dev stack it could also move the dev
  database port under a running database first. A running stack whose `db`
  container has stopped is now refused with the "local stack isn't running" message rather than
  having its database started.


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
