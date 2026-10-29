# Browser end-to-end tests

Playwright, Chromium only, driving a **running** stack.

## Running them

```sh
bash tests/integration/scripts/studio-ui-e2e.sh
```

That brings compose up, creates a Studio admin, and runs the suite. To drive a
stack you already have:

```sh
cd tests/e2e
E2E_BASE_URL=http://127.0.0.1:18473 pnpm e2e
pnpm e2e:headed          # watch it happen
pnpm report              # the HTML report from the last run
pnpm install:browser     # first time, or in CI
```

## What is covered

| Group | Asserted on |
|---|---|
| Sign in | the bundle renders, assets come from the mount path, a wrong password is refused, a right one gets in |
| Dashboard | a database size the server measured |
| Models | the pushed schema's models are listed, the row grid carries the model's own columns, the per-model tabs exist, and the schema tab names its fields |
| Database | tables listed with the schemas a real introspection finds and the sizes Postgres reports; the SQL runner returns a row the database computed |
| Auth | users lists the account that signed in, providers shows each one with its state, configuration shows the settings it can change, and policies shows the RLS the database actually has |

Each assertion is made **in the element that would hold the data**, not on the
page as a whole. The sidebar alone contains "Users", "Email" and every model
name, so a test that checks the page merely contains a word passes on a view
that rendered nothing.

Proven by moving `.supatype/admin-config.json` aside: all nine view specs fail,
and pass again when it is restored.

## Why these tests exist

The rest of the repository tests Studio's **server** surface: the bundle is
served with a 200, `/studio/session` answers, `/studio-config` answers. All of
that stays green through a bundle that loads and then throws, an asset referenced
at the wrong base path, or a sign-in form wired to nothing.

So these assert what a person would notice: the page renders, its assets come
from the path it is mounted on, a wrong password is refused, and a right one gets
you in.

## Two conventions worth keeping

**No `webServer` block.** The integration scripts already know how to bring a
stack up, and a second way to start the same thing is a second thing to keep in
step. Point `E2E_BASE_URL` at a stack instead.

**The script is `e2e`, not `test`.** A script called `test` joins turbo's default
test pipeline, where it fails: that pipeline provides no stack. Naming it `e2e`
keeps `pnpm turbo run test` meaning "the tests that need nothing".

## Expected non-200s

Two 4xx are states, not faults, and the specs allow exactly these:

| | |
|---|---|
| `401` before sign-in | the point of the sign-in page |
| `404 /studio-config` | "schema not pushed yet": a project with no generated admin config genuinely is that, and Studio reads it and carries on |

## Open Studio on the origin it is configured with

`E2E_BASE_URL` must be the URL in Studio's own config, which locally is
`http://localhost:<kong>`. Open it on `http://127.0.0.1:<kong>` instead and the
two are different origins: every credentialed request Studio makes through
`/studio/proxy` is refused by CORS, and each view reads **"Failed to fetch"**,
which cannot be told apart from a broken view. The runner passes the right one; the health
polling separately uses `127.0.0.1`, because `localhost` resolves to `::1` first
on some hosts.

## These need a pushed schema

Studio reads its model and database views from the admin config the engine writes
on `push`. Without it every view is the "No schema has been pushed yet" screen.
The runner pushes if the file is missing and fails with an explanation if it
still cannot, which locally means the host engine could not be downloaded: set
`SUPATYPE_RELEASE_PUBLIC_KEY`, or `SUPATYPE_ALLOW_UNVERIFIED_DOWNLOADS=1`.

## The masking matrix and the positioning checks

Two suites here drive no browser at all. They are API and WebSocket clients, kept
beside the browser specs because they share Playwright's runner and its
expected-fail marks, and each has a runner script that brings its own stack up:

| Suite | Runner | What it asserts |
|---|---|---|
| `masking/` | `bash tests/integration/scripts/masking-e2e.sh` | Field masking and row visibility on REST (with filter, order, count, cast and CSV oracles), REST writes, realtime and GraphQL, for anon, two users, an admin and service_role, in tier 1 (`supatype_mask`) and tier 2 (the `api` views) |
| `positioning/` | `bash tests/integration/scripts/positioning-e2e.sh` | In a project made by `init`, under `supatype dev`: a new field reaches the generated types, and a rename never empties the column |

A test that asserts correct behaviour while a known defect is open calls
`expectDefects([...ids])` (`masking/lib/defects.ts`), which marks it expected to
fail. The run is green while the defect is open; once it is fixed the test
passes, Playwright reports "expected to fail, but passed", and the run is red
until the id is removed from the test. Each id is an entry in
Pre-Launch-Verification-Register.

Both runners count a skipped test as a failure. Both run on every pull request
and push to main (`masking-e2e` and `positioning-e2e` in
`.github/workflows/integration.yml`), against this checkout's images and the
pinned engine, server and Postgres. Both are also suites of the release train
(`scripts/release-train.sh`, `.github/workflows/release-train.yml`).
