# Supabucks

A coffee-shop loyalty card: sign in, buy a drink to earn stars, redeem them for rewards.

The app is a Vite and React SPA built to `./dist` and served by Supatype itself
(`app.mode: "static"`). The page and the API share one origin, `http://localhost:18473`, so there is
no CORS and one command runs everything.

## What is in it

- `schema/index.ts`: `Customer`, keyed by the auth user's id and readable only by its owner, and
  `Activity`, one row per star earned or spent
- `src/`: the SPA. `src/supatype.ts` creates the client against `window.location.origin`
- `seeds/`: a demo card for one sign-in user

## Running it

Running this outside the repo? See [Running an example](../README.md#running-an-example).

From the monorepo root:

```bash
pnpm install
pnpm build                               # the CLI and the libraries run from their dist/

cd examples/supabucks
echo "JWT_SECRET=$(openssl rand -base64 48)" > .env
pnpm exec supatype keys                  # mints the keys, VITE_SUPATYPE_ANON_KEY included, into .env
pnpm build                               # not the repo build: this example's own `vite build` into ./dist
pnpm dev                                 # the stack, serving ./dist at /, and the schema pushed
```

Open `http://localhost:18473/` and sign up.

The order matters. Vite reads `VITE_SUPATYPE_ANON_KEY` at **build** time, so a build made before the
keys exist has no key, and the app stops at start with "VITE_SUPATYPE_ANON_KEY is not set". Rebuild
after you mint new keys, and after any change to `src/`. Until the first build, `/` answers 404:
static mode serves whatever is in `./dist`.

## Seed a demo card

`pnpm seed` runs `supatype seed`, which applies `seeds/*.ts` in order. Every row here belongs to a
sign-in user, and a seed cannot create users, so create the demo account first:

```bash
pnpm exec supatype admin create-user --email demo@supabucks.test --password <password> --role viewer
pnpm seed
```

Sign in as `demo@supabucks.test` to see a card with stars and a few weeks of history. Without that
account the seed writes nothing. It is safe to run again: it resets the card's totals and adds only
the history rows the account does not have.

## Tests

`pnpm test` runs the unit tests. `bash tests/integration/scripts/supabucks-e2e.sh` (from the
monorepo root) builds the app, starts the stack and checks that `/` serves the built shell, that a
path with no file falls back to it, and that the bundle's key is accepted by the API.
