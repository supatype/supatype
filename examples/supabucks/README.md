# Supabucks

A coffee-shop loyalty card: sign in, earn stars, redeem rewards.

The app is a Vite and React SPA built to `./dist` and served by Supatype itself
(`app.mode: "static"`). The page and the API share one origin, `http://localhost:18473`, so there is
no CORS and one command runs everything.

## What is in it

- `schema/index.ts`: `Customer`, keyed by the auth user's id and readable only by its owner, and
  `Activity`, one row per star earned or spent
- `src/`: the SPA. `src/supatype.ts` creates the client against `window.location.origin`

## Running it

Running this outside the repo? See [Running an example](../README.md#running-an-example).

From the monorepo root:

```bash
pnpm install
pnpm build                               # the CLI and the libraries run from their dist/

cd examples/supabucks
echo "JWT_SECRET=$(openssl rand -base64 48)" > .env
pnpm exec supatype keys --write          # mints the keys, VITE_SUPATYPE_ANON_KEY included, into .env
pnpm build                               # not the repo build: this example's own `vite build` into ./dist
pnpm dev                                 # the stack, serving ./dist at /
```

Open `http://localhost:18473/` and sign up.

The order matters. Vite reads `VITE_SUPATYPE_ANON_KEY` at **build** time, so a build made before the
keys exist has no key, and the app stops at start with "VITE_SUPATYPE_ANON_KEY is not set". Rebuild
after you mint new keys.

## Checked in CI

`bash tests/integration/scripts/supabucks-e2e.sh` (from the monorepo root) builds the app, starts
the stack, and checks that the built page and its bundle are served, with the key baked in, and
that the API accepts that key.
