---
name: supatype
description: >-
  Guides working with Supatype: project setup, supatype.config.ts,
  schema/index.ts, CLI (dev, push, diff, generate), generated types,
  @supatype/client integration, and self-host. Use when the user mentions
  Supatype or is building on the Supatype stack.
---

# Supatype

Guide for working with Supatype projects. If unsure about a command or flag, run `supatype --help` (or `supatype <command> --help`): published docs may lag the installed CLI.

## Quick reference

| Topic | Reference |
|-------|-----------|
| Config and `.env` | [references/config.md](references/config.md) |
| Schema and access rules | [references/schema.md](references/schema.md) |
| CLI commands | [references/cli.md](references/cli.md) |
| Seeding | [references/seeding.md](references/seeding.md) |
| Frontend, client, React hooks + auth components | [references/frontend.md](references/frontend.md) |
| SAML single sign-on (`auth.sso.saml`, `supatype sso`, `signInWithSSO`, `SSOForm`) | [references/cli.md](references/cli.md#single-sign-on-saml), full guide https://www.supatype.com/docs/sso.html |
| Production frontend builds (`supatype build`, Vercel, Netlify, CI) | [references/frontend.md](references/frontend.md#production-builds) |
| REST GET caching (client + server) | [references/caching.md](references/caching.md) |
| Self-host production | [references/self-host.md](references/self-host.md) |

## Prerequisites

Node.js 18 or later for the CLI (a Vite 8 app needs 20.19 or later), Docker (default provider), npm/pnpm/yarn.

Install the CLI with npm, or on Linux and macOS with the install script or Homebrew (on Windows, use npm):

```bash
npm install -g @supatype/cli
curl -fsSL https://supatype.com/install.sh | bash
brew install supatype/tap/supatype
```

## New project

```bash
npx @supatype/cli init <project-name>     # asks its questions; --defaults (-y) takes the defaults
cd <project-name>
npm run dev                                # supatype dev: applies the schema, generates types, watches both
```

Then open the URL init printed (`Open http://localhost:<port>`). For a Docker project init picks
the gateway (Kong) port: the first free one from 18473 up, or the one you typed, kept in `.env` as
`SUPATYPE_KONG_PORT` and `API_EXTERNAL_URL`. Do not assume 18473. Init installs the packages and
writes the keys itself; when it could not, it prints a "Finish setup:" list naming what is left
(`npm install`, `supatype update`, `supatype keys`), so follow that list rather than guessing.

`npm run dev` starts the app's dev server too, whatever the production target: for a static Vite
app init writes `supatype.local.config.ts` with `app.mode: "proxy"` and `start: "vite"`, and a
"local dev server" app is proxy mode already. An init-made project never needs a second terminal.

`supatype dev` keeps running. It pushes the schema when it starts and on every save, and
regenerates the typed client each time; there is no separate `push` step locally. `push` is for
another database: `supatype push --env <name>`, or a linked target.

It also stops, and stops its stack the way Ctrl+C does, within a few seconds of the process that
started it exiting: a script that was killed, a cancelled CI job, an agent's command that timed out.
So start it in the foreground, or from a process that stays alive. To leave a stack running with
nothing attached, use `supatype self-host compose up -d` instead. A script that backgrounds it
should `exec` it, `(cd app && exec npx supatype dev) &`, so `$!` is `dev` itself.

To run a second stack of the same project (another checkout, a test run), set
`SUPATYPE_PROJECT_NAME=<name>` or pass `--project-name <name>`, with its own `SUPATYPE_KONG_PORT`:
the compose project and the database follow the name for that run, and no file is written.

Install matching versions of CLI, client, and types from npm (`latest` is the current release):

```bash
npm install @supatype/cli@latest @supatype/client@latest @supatype/types@latest
```

Pin all `@supatype/*` packages to the **same version** to avoid client/type skew.

Omit `versions` in `supatype.config.ts` to run the exact images the installed CLI release was tested with.

**Scaffold:** run `supatype init` and answer its prompts (production target, local runtime, schema
path, front end), or pass `--defaults` to take the defaults. `--mode dev | standalone` still works
for older scripts. For wiring a front end, see [references/frontend.md](references/frontend.md).

## Daily workflow

1. Edit `schema/index.ts` (source of truth: type-first, not DB introspection)
2. With `supatype dev` running, saving applies the change and regenerates types
3. `supatype diff --env <name>` then `supatype push --env <name>`: apply it to another database
4. Renaming a field or model: record it with `supatype rename <table>.<old> <table>.<new>` (or
   `supatype rename <old_table> <new_table>`) and commit `supatype/renames.json`. Renames are
   never guessed; an unrecorded rename is a drop plus an add, which loses the column's data
5. Use generated types with `@supatype/client` in app code

## Core facts

- **Default provider:** `"docker"`, scaffolded in `supatype.config.ts` and used when no provider is set
- **Native alternative:** `provider: "native"`: host Postgres :5432, supatype-server :18471. Not everything the Docker stack has: pg_graphql and `/graphql/v1` are Docker-only, pg_net is not on Windows, and PostGIS is not on macOS for now (see [config.md](references/config.md#switching-to-native-dev))
- **Schema API:** `@supatype/types` `Model<>` types, not `@supatype/schema`
- **Config:** `supatype.config.ts` + `defineConfig`; TOML unsupported
- **Docker API URL:** `http://localhost:<SUPATYPE_KONG_PORT>`, the port in `.env` (init takes 18473 or the next free one), also kept there as `API_EXTERNAL_URL`
- **Types output:** `types/database.ts` by default, beside the generated client at `supatype/generated/client.ts`; set `output: { types: "path/to/file.ts" }` in config to move it
- **Local overrides:** `supatype.local.config.ts` (gitignored)

## Client usage

```typescript
// The generated client, not "@supatype/client": it registers which models keep drafts.
import { createClient } from "./supatype/generated/client"

const supatype = createClient({
  url: import.meta.env.VITE_SUPATYPE_URL,
  anonKey: import.meta.env.VITE_SUPATYPE_ANON_KEY,
})

const { data } = await supatype.from("post").select("*")
const { data: created } = await supatype.from("post").insert({ title: "Hello" }).select("id").single()
```

The CLI writes the local stack's URL and anon key to `.env.development.local`, read in development
only, so a production build gets neither from it. **Build for production with `supatype build`**
(`supatype build -- vite build`, or bare to run the package.json `build` script): it runs the build
with the deployment's URL and anon key under every framework prefix, from the environment, else (anon key
only) the `/supatype-env.json` of the server that URL names, else the linked environment
(`--env <name>`), else a `.env` recording a deployment; a key held for another deployment is
skipped. It refuses to start when
either is missing or the URL is local (`--allow-local` overrides). For a host's settings,
`supatype keys --print frontend --env <name>` prints the same values as `NAME=value` lines. When
Supatype serves the app, `<script src="/supatype-env.js" vite-ignore></script>` in `index.html` gives the page
both values at load time (`vite-ignore` stops `vite build` warning that it cannot bundle the script); a Next.js app serves the same script from `app/supatype-env.js/route.ts`
(`export { GET } from "@supatype/ssr/next"`, see [frontend.md](references/frontend.md#nextjs)). Pass the
values straight to `createClient` with no guard of your own: creating it never throws, and its first
request throws a `MissingClientValuesError` naming what is missing. See
[references/frontend.md](references/frontend.md#production-builds).

Writes (`insert`, `update`, `upsert`, `delete`) return `data: null` unless you chain `.select()`;
`.single()` and `.maybeSingle()` on a write need `.select()` before them.

Call `createClient` with no type argument: the generated client already carries the schema's types.
`createClient<Database>` loses the drafts typing (`update(..., { publish: true })` stops compiling)
and makes every `rpc(...)` name `never`.

Add `@supatype/client` when wiring a frontend. `supatype dev` applies schema changes locally as you save; `supatype push --env <name>` applies them elsewhere.

**Prefer first-party framework bindings over the raw client.** For React use `@supatype/react` (`SupatypeProvider`, `useAuth`, `useQuery`, `useMutation`, `useSubscription`) and `@supatype/react-auth` (`LoginForm`, `SignUpForm`, `OAuthButton`); equivalents exist for Vue/Solid/Svelte, plus `@supatype/ssr` for server rendering. Don't hand-roll auth forms or auth state. See [references/frontend.md](references/frontend.md).

**SAML single sign-on** is off until `auth: { sso: { saml: { enabled: true } } }` in `supatype.config.ts`; the CLI then writes the signing key `SUPATYPE_SAML_PRIVATE_KEY` to `.env` (never the config). Identity providers are runtime data: `supatype sso add <name> --metadata-url <url> --domains acme.com` (the server fetches the URL, so the IdP must be reachable from its container; `http` only on a dev stack), `sso info` for the SP entity ID, ACS URL and signing certificate (every `sso` command warns while SAML is off), `sso verify-domain` for the `_supatype-challenge.<domain>` TXT record (only a verified domain links SAML sign-ins to existing accounts), `sso rotate-key` with a restart before and after `--promote`. Sign in with `signInWithSSO({ domain })` or `<SSOForm />` (PKCE by default). Guide: https://www.supatype.com/docs/sso.html

## Common failures

| Error | Fix |
|-------|-----|
| Docker not running | Start Docker before `supatype dev` |
| Port in use | `supatype dev` prompts for another port, or set a unique `SUPATYPE_KONG_PORT` per project in `.env` |
| Wrong project / holding page | Another stack may own your Kong port; use the URL from `supatype dev` output |
| Docker still running after dev | Run `supatype self-host compose down`; check Docker Desktop for orphaned `supatype-*` stacks |
| Renamed project, old containers | Next `supatype dev` offers to stop the old stack; or `docker compose -p supatype-<old-name> down` |
| Missing JWT keys | `supatype keys` (fills the blank keys in `.env`) |
| Production site is a blank page; console says `Supatype client has no anon key.` | The build had no anon key. Build with `supatype build` and set `SUPATYPE_URL` in the host's settings (the anon key is fetched from that server's `/supatype-env.json`; set `SUPATYPE_ANON_KEY` too only if it does not publish one). `supatype keys --print frontend` prints both |
| `No anon key for a production build of the front end.` (or `No API URL ...`) | `supatype build` found no usable value in the environment, the server the URL names, the link or `.env`; the lines under it say why for each. Set `SUPATYPE_ANON_KEY` / `SUPATYPE_URL`, or run `supatype build --env <name>` on a linked project |
| ``The package.json build script calls `supatype build` itself, so running it again would never end.`` | package.json's `build` script is `supatype build`. Put the real command there (`vite build`), and run `supatype build` from the host or CI instead |
| Next.js page works locally, deployed one throws `Supatype client has no API address and anon key.` | Set `SUPATYPE_URL` and `SUPATYPE_ANON_KEY` in the host where the app runs (not `NEXT_PUBLIC_`): the error quotes the reason `/supatype-env.js` set, naming each one that is unset. Check the app has `app/supatype-env.js/route.ts` and the root layout loads `/supatype-env.js` with `beforeInteractive` |
| `JWT_SECRET in .env is <n> characters, and the REST API needs at least 32.` | Put a longer secret in `.env` (`openssl rand -base64 48`), then `supatype keys --force` |
| REST answers `503` / `PGRST002` on a fresh self-host stack | Expected until the first `supatype push`; push waits up to 40 s for REST to load the schema |
| ``The process that started `supatype dev` has exited, so dev is stopping its stack.`` | The starter (script, CI step, agent command) exited. Keep `dev` in the foreground, or use `supatype self-host compose up -d` |
| `.env` change not picked up by a running stack | `supatype self-host compose restart <service>` (not `docker compose restart`) |
| No supatype.config.ts | `supatype init` |
| Types out of sync | Keep `supatype dev` running (it regenerates on every save), or run `supatype generate` |
| Insert or update `data` is `null` | Writes return no rows until you chain `.select()` (or pass `select` to `useMutation`) |
| Destructive migration blocked | Review `supatype diff`; use `supatype push --yes` if intended |
| `SupatypeClient<Database>` not assignable to `SupatypeClient<any>` | Version skew between app's `@supatype/client` and the one `@supatype/react`(-auth) pulls; add npm `overrides: { "@supatype/client": "$@supatype/client" }` |

## When to read references

- **Schema design, access, relations, buckets** → [references/schema.md](references/schema.md)
- **Command flags and workflow** → [references/cli.md](references/cli.md)
- **Seed data, the ledger, `runOnce`** → [references/seeding.md](references/seeding.md)
- **Astro/Vite/Next wiring, React hooks, auth UI components** → [references/frontend.md](references/frontend.md)
- **Production compose** → [references/self-host.md](references/self-host.md)
