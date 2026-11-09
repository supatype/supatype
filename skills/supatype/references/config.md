# supatype.config.ts reference

Canonical config uses `defineConfig` from `@supatype/cli`. Optional `supatype.local.config.ts` merges on top (gitignored) for local development only: `supatype dev` reads it, while the self-host commands, `deploy` and a push to a production stack (a linked self-host server, or the project's own stack running standalone) use `supatype.config.ts` alone, printing one line when they leave an override out.

## Minimal scaffold (from `supatype init`)

```typescript
import { defineConfig } from "@supatype/cli"

export default defineConfig({
  project: { name: "my-project" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
  email: { provider: "console" },
  storage: { provider: "local", local_path: ".supatype/storage" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
  output: { types: "types/database.ts", client: "supatype/generated/index.d.ts" },
})
```

The types land in `types/database.ts` and the client in `supatype/generated/client.ts`, beside
`index.d.ts`. With `provider: "native"`, init also writes `server.port: 18471`, the port the native server
listens on. A Docker project's API is on the gateway port, `SUPATYPE_KONG_PORT` in `.env`.

**Docker images:** omit `versions` so compose runs the exact images the installed CLI release was tested with (never `:latest`). Pin `versions.*` only when you need a different release.

## Self-host scaffold

What `supatype init` writes when you choose a self-hosted production target (`--mode standalone`
does the same for older scripts):

```typescript
export default defineConfig({
  project: { name: "my-project" },
  provider: "docker",
  database: { provider: "docker" },
  server: {
    mode: "standalone",
    domain: "demo.supatype.com",
    tls: { email: "you@example.com" },
  },
  app: {
    mode: "static",
    static_dir: "./dist",  // production build output
  },
  environments: { default: "production" },
  email: { provider: "console" },
  storage: { provider: "local", local_path: ".supatype/storage" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
  output: { types: "types/database.ts", client: "supatype/generated/index.d.ts" },
})
```

Init also writes `supatype.local.config.ts`, which keeps `supatype dev` on local HTTP and, with
Vite, runs the app as a proxy that `dev` starts:

```typescript
import type { SupatypeConfig } from "@supatype/cli"

const localConfig: Partial<SupatypeConfig> = {
  server: { mode: "dev" },
  app: {
    mode: "proxy",
    upstream: "http://127.0.0.1:5173",
    start: "vite",
    vite_dev_url: "http://127.0.0.1:5173",
  },
}

export default localConfig
```

## Key fields

| Field | Notes |
|-------|-------|
| `provider` | Top-level runtime: `"docker"` (the default, also when omitted) or `"native"` |
| `database.provider` | Same values; used when `provider` omitted |
| `server.mode` | `"dev"`, `"standalone"` (self-host with HTTPS), or `"managed"` (cloud) |
| `server.port` | supatype-server port (native dev) |
| `server.domain` | Custom domain for self-host HTTPS (e.g. `"demo.example.com"`) |
| `server.tls` | `{ email, provider }`: Let's Encrypt contact email; `provider: "kong"` (default, Kong ACME) or `"none"` (stay HTTP). Set via `supatype add domain` |
| `server.public_env` | `false` turns off the server's `GET /supatype-env.json` and `GET /supatype-env.js` (both answer 404), rendered as `SUPATYPE_PUBLIC_ENV=false` for self-host compose, dev compose and native dev. Unset (the default) leaves them on: they publish the API URL and anon key for `supatype build` and a page's `<script src="/supatype-env.js">`. For an API-only project. The anon key is public either way, so this does not make it a secret. Anything but a boolean is refused |
| `app.mode` | `"none"`, `"static"`, or `"proxy"` |
| `app.static_dir` | Built static assets directory |
| `app.vite_dev_url` | Vite dev server URL for HMR (`/_vite/*`) when using **static** mode locally, e.g. `http://127.0.0.1:5173`. Sets `SUPATYPE_VITE_DEV_URL` during `supatype dev` |
| `app.upstream` | Proxy target for SSR/dev servers (proxy mode) |
| `app.start` | package.json script name to run in proxy mode (e.g. `"vite"`) |
| `output.types` | Generated TypeScript types path |
| `build` | Framework build integration for `supatype deploy` (`framework`, `buildCommand`, `outputDirectory`, `env`) |
| `versions.*` | Optional pin for engine, server, postgres, deno. **Omit to run the CLI release's own images** |
| `connection` | Override database URL (else `DATABASE_URL` env) |
| `auth.providers` | OAuth providers (`github`, `google`, ...): `clientId`, `secret: env("NAME")`, optional `redirectUri`, `url`. See [OAuth providers](#oauth-providers) |
| `auth.sso.saml` | SAML single sign-on: `enabled` (required), optional `allowEncryptedAssertions`, `relayStateValidity` (seconds), `rateLimitAssertion`, `externalUrl`. Turning it on makes the next `dev` or `self-host compose up` write `SUPATYPE_SAML_PRIVATE_KEY` to `.env` once; a `privateKey` field here is refused. Identity providers are not config: register them with `supatype sso add` (see [cli.md](cli.md#single-sign-on-saml) and https://www.supatype.com/docs/sso.html) |
| `studio.auth.providers` | The OAuth providers Studio's sign-in offers, e.g. `["keycloak"]`. Unset offers every enabled provider. A Studio role is still required. See [Studio sign-in](#studio-sign-in-with-the-projects-providers) |
| `auth.email.enableConfirmations` | `true` makes a new email sign-up confirm its address before it can sign in. Off when unset: dev auto-confirms. Written as `SUPATYPE_MAILER_AUTOCONFIRM` for docker dev, native dev and the self-host compose file; a value you put in `.env` yourself wins. See [Email confirmation](#email-confirmation) |
| `api.corsOrigins` | Browser origins allowed to call the API besides `SITE_URL`, e.g. `["https://admin.example.com"]`. `"*"` allows every origin and is never a default. `SUPATYPE_CORS_ALLOW_ORIGINS` in `.env` adds to it; a list saved in Studio (Settings, CORS tab) replaces both until reset (the site URL is always allowed). Dev mode allows every origin |

## .env essentials

`supatype init` generates the secrets below; they are per project, not fixed defaults.

```bash
DATABASE_URL=postgresql://supatype_admin:<POSTGRES_PASSWORD>@localhost:5432/my-project
POSTGRES_PASSWORD=      # generated by supatype init, for direct SQL access
AUTHENTICATOR_PASSWORD= # generated: PostgREST's own login, deliberately not the above
SUPATYPE_SQL_EDITOR_PASSWORD= # generated: Studio SQL editor's login, not a superuser
JWT_SECRET=             # generated: signs ANON_KEY / SERVICE_ROLE_KEY; at least 32 characters
SUPATYPE_CONTROL_PLANE_SECRET= # generated: only the server and the control plane get it
ANON_KEY=           # written by init, or: supatype keys
SERVICE_ROLE_KEY=   # written by init, or: supatype keys; also the token for the self-host /platform/v1 API
SITE_URL=http://localhost:18473      # docker: the local gateway URL init chose
SUPATYPE_KONG_PORT=18473             # docker: init takes 18473 or the next free port
API_EXTERNAL_URL=http://localhost:18473
# Optional, off by default: a raw database URL handed to every function as ctx.dbUrl. It bypasses
# row rules and field masking, so use a least-privilege role, never the admin URL (self-host.md).
# SUPATYPE_FUNCTIONS_DB_URL=postgresql://functions_reader:<password>@db:5432/my-project

# Written by supatype dev (docker):
# SUPATYPE_DEV_DB_PORT=54329
```

The front end's copies (`VITE_SUPATYPE_URL`, `VITE_SUPATYPE_ANON_KEY` and their `PUBLIC_`,
`NEXT_PUBLIC_`, `EXPO_PUBLIC_` twins) are not in `.env` for a local stack: they go to
`.env.development.local`, read in development only, so a production build never ships localhost or
the dev anon key. A production build gets a deployment's values from `supatype build` (see
[frontend.md](frontend.md#production-builds)).

`supatype dev` **does not** rewrite `POSTGRES_PASSWORD` or `JWT_SECRET`. It reads them, so a
generated secret reaches production intact. It does rewrite the keys derived from them
(`ANON_KEY`, `SERVICE_ROLE_KEY`), which is why those must not be edited by hand.

Do **not** set `SUPATYPE_*_IMAGE` env vars unless overriding: pinned image tags in `.env` override the CLI release's image defaults.

## Link and environment files

| File | Purpose |
|------|---------|
| `.supatype/link.json` | Unified link state: cloud or self-host targets, tokens, environments map |
| `.supatype/environment.json` | Written by `supatype dev`: local Kong URL, DB URL, project ref |

Add `.supatype/` to `.gitignore` (done by `supatype init`; use `supatype link --fix-gitignore` if missing). Never commit `link.json`, because it contains tokens.

`supatype.config.ts` can name the environment a command targets when `--env` is left out:

```typescript
environments: {
  default: "production",
},
```

Or pick it by git branch, with `branchDefaults` in place of `default`:

```typescript
environments: {
  branchDefaults: { main: "production", "feature/foo": "staging" },
},
```

`default` wins: with it set, `branchDefaults` is never read.

### Who owns `DATABASE_URL` in `.env`

- **The CLI's**: the URL sits under `# supatype:managed, built from supatype.config.ts and the POSTGRES_ values below` (what `init` writes; an older `# supatype:managed` marker counts too), or is exactly the URL the CLI writes (`supatype_admin`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, a host on this machine, any port). Docker dev, native dev and a saved shell port rewrite it to the provider and port the project runs, and host commands (`push`, `seed`, `admin`) use the project's own database in its place. The line belongs to dev: self-host commands never rewrite it, and reach the self-host stack's Postgres (on `SUPATYPE_DB_PORT`, 5432 unless set) for their own run only.
- **Yours**: anything else. No command changes it, host commands use it as written, and dev warns when nothing answers where it points. Remove it to go back to the project's own database.

## Self-host HTTPS (custom domain)

`supatype add domain` writes this block; the self-host compose stack then publishes Kong on `:80`/`:443`, gives it a RESP store for its certificates, and issues a Let's Encrypt certificate automatically:

```typescript
server: {
  mode: "standalone",
  domain: "demo.example.com",
  tls: { email: "you@example.com", provider: "kong" },
},
```

Apply with `supatype self-host compose up -d`, which reads `supatype.config.ts` without the local override. Keep a `supatype.local.config.ts` with `server: { mode: "dev" }` and **app proxy** for Vite local dev; the self-host commands never read it:

```typescript
export default {
  server: { mode: "dev" },
  app: {
    mode: "proxy",
    upstream: "http://127.0.0.1:5173",
    start: "vite",
    vite_dev_url: "http://127.0.0.1:5173",
  },
}
```

Committed `supatype.config.ts` stays `app.mode: "static"` for production.

## OAuth providers

Configure sign-in providers in the config; `supatype dev` and `supatype self-host compose` turn them
into the `SUPATYPE_EXTERNAL_<PROVIDER>_*` variables the auth server reads:

```typescript
import { defineConfig, env } from "@supatype/cli"

export default defineConfig({
  // ...
  auth: {
    providers: {
      github: { clientId: "Iv1.0123456789abcdef", secret: env("GITHUB_SECRET") },
      google: { clientId: env("GOOGLE_CLIENT_ID"), secret: env("GOOGLE_SECRET") },
    },
  },
})
```

```bash
# .env
GITHUB_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_SECRET=...
```

- **Callback URL to register with the provider:** `<public API URL>/auth/v1/callback`, e.g.
  `http://localhost:18473/auth/v1/callback` in docker dev (the Kong port from `.env`), or
  `https://<server.domain>/auth/v1/callback` in production. That is the default `redirectUri`; set
  `redirectUri` only when the public URL differs.
- **Secrets are `env("NAME")` only.** A literal `secret` is rejected: the config is committed, and the
  compose file names the variable instead of holding the value. `env("NAME")` is the same `env(NAME)`
  reference Supabase's `config.toml` uses.
- **Fields:** `enabled` (default `true`), `clientId`, `secret`, `redirectUri`, `url` (self-hosted
  providers: GitHub Enterprise, GitLab, Keycloak, WorkOS), `skipNonceCheck`, `emailOptional`.
- **Provider names** are the ones `signInWithOAuth({ provider })` takes: `apple`, `azure`,
  `bitbucket`, `discord`, `facebook`, `figma`, `fly`, `github`, `gitlab`, `google`, `kakao`,
  `keycloak`, `linkedin`, `linkedin_oidc`, `notion`, `slack`, `slack_oidc`, `snapchat`, `spotify`,
  `twitch`, `twitter`, `vercel_marketplace`, `workos`, `x`, `zoom`. Anything else is rejected.
- **Precedence:** a `SUPATYPE_EXTERNAL_<PROVIDER>_*` value already in `.env` wins over the config, so
  a project configured through `.env` alone keeps working. `supatype dev` and
  `supatype self-host compose render`/`up` warn when an enabled provider's secret is set nowhere.
- **Configured only through `.env`:** nothing is rendered for a provider the config does not list,
  so it gets no default redirect. Set `SUPATYPE_EXTERNAL_<PROVIDER>_REDIRECT_URI` yourself, to
  `<public API URL>/auth/v1/callback`, the `API_EXTERNAL_URL` in `.env` (the gateway's
  `SUPATYPE_KONG_PORT` under Docker, `server.port` natively); without it the server refuses the
  provider. Listing the provider under `auth.providers` is the recommended route,
  since it supplies that default.
- `supatype.local.config.ts` merges per provider, so it can swap in a development OAuth app's
  `clientId` without restating the rest.

### Studio sign-in with the project's providers

Studio's sign-in page offers every OAuth provider the auth server has enabled ("Continue with
Keycloak", "Continue with GitHub") alongside email and password. Nothing extra is registered with
the provider: Studio uses the same `/auth/v1/callback`, and the server sends the browser back to
`<public API URL>/studio/` by itself, whatever `SITE_URL` is (no `SUPATYPE_URI_ALLOW_LIST` entry).

**Signing in is not access.** Studio still needs a Studio role (see Studio roles in
[self-host](self-host.md#studio-roles)). Somebody who signs in with a provider and has no role sees
"Access denied" until an admin grants one; nobody gets a role automatically. An existing admin who
signs in with a provider that returns the same verified email keeps their user and their role.

To offer only some providers on Studio's page:

```typescript
studio: { auth: { providers: ["keycloak"] } }
```

Names are the ones `auth.providers` takes (or `custom:<identifier>`); an unknown name is rejected.
A named provider the server has off is not offered. The list reaches Studio in the Studio
container's `SUPATYPE_CLOUD_JSON`, so a Studio served by `overrides.studio` offers every enabled
provider.

## Email confirmation

A dev stack confirms every email sign-up by itself, so `signUp` returns a session straight away.
To test the confirmation email instead, turn confirmations on (the same switch as Supabase's
`[auth.email] enable_confirmations`):

```typescript
// docs:no-check (a fragment: the rest of your config stays as it is)
import { defineConfig } from "@supatype/cli"

export default defineConfig({
  auth: { email: { enableConfirmations: true } },
})
```

- `signUp` then returns the user with `session: null`, stores nothing and emits no `SIGNED_IN`;
  `SignUpForm` shows "Check your email to confirm your account."
- Docker `supatype dev` writes `SUPATYPE_MAILER_AUTOCONFIRM` into `.env` under a
  `# supatype:managed` marker and updates it on every start; native dev passes it to the server;
  `supatype self-host compose` uses it as the fallback for `${SUPATYPE_MAILER_AUTOCONFIRM:-...}`.
- **Your own `.env` value wins.** A `SUPATYPE_MAILER_AUTOCONFIRM` without the marker is left alone,
  except `true` with no marker, which is what earlier CLIs wrote on every start and is replaced.
  A value in `.env.local` always wins in native dev.
- The emails go wherever `email.provider` sends them: `console` (the default) logs them.

## Switching to native dev

```typescript
export default defineConfig({
  provider: "native",
  database: { provider: "native" },
  // ...
})
```

Requires no Docker. Uses host Postgres on :5432 and supatype-server on `server.port` (default 18471).

The native Postgres is not the Docker image, and some of what the image has is missing:

- **GraphQL:** pg_graphql and `/graphql/v1` are Docker-only; native dev answers `/graphql/v1` with
  501 `graphql_unavailable`. Use REST, or the Docker provider.
- **pg_net:** not on Windows. On Linux and macOS it is preloaded, with pg_cron, as in the image.
- **PostGIS:** not on macOS for now. Geometry fields need Linux, Windows or the Docker provider.

pg_stat_statements, pg_cron, pg_net, plan_filter and safeupdate are preloaded when the downloaded
archive carries them, so an older archive starts as it did. safeupdate refuses an `UPDATE` or
`DELETE` with no `WHERE` in every session, as in the image: write `WHERE true` to mean every row.

The native Postgres checks passwords (`scram-sha-256` for local and host connections): the
superuser `postgres` uses `.env`'s `POSTGRES_PASSWORD` and PostgREST's `authenticator` uses
`AUTHENTICATOR_PASSWORD`; `dev` and `supatype pg start` generate either into `.env` when missing.
A data directory an older CLI made with `trust` is converted on its next start. Connect with
`supatype pg psql`, or `PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres <project>`.

## Project name for one run

`SUPATYPE_PROJECT_NAME=<name>` (or `--project-name <name>` on any command) replaces `project.name`
for that run only and writes nothing. See [cli.md](cli.md).
