# Blog

A small Next.js blog, served through Supatype's own gateway.

It is the example to copy when you want server rendering, publishing and rich text without the
rest of the platform. Posts keep drafts and history. An unpublished post cannot be read
(`Lte<"published_at", Now>`). The body is rich text in English and French.

## What is in it

- `schema/index.ts`: users, posts, comments, and buckets for avatars, covers and attachments
- `app/`: the Next.js app. The home page and post pages are Server Components that read through
  `@supatype/ssr` (`lib/supatype-server.ts`); `/login`, `/signup` and the new-post form run in
  the browser
- `app/preview/[slug]`: a saved draft, read with a preview link's code and no other credential
- `functions/greet`: one edge function

## Running it

Running this outside the repo? See [Running an example](../README.md#running-an-example).

From the monorepo root:

```bash
pnpm install
pnpm build                               # the CLI and the libraries run from their dist/

cd examples/blog
echo "JWT_SECRET=$(openssl rand -base64 48)" > .env
pnpm exec supatype keys --write          # mints ANON_KEY and SERVICE_ROLE_KEY into .env
cp .env.local.example .env.local         # paste ANON_KEY from .env into NEXT_PUBLIC_SUPATYPE_ANON_KEY
pnpm exec supatype dev                   # the stack, and Next on :3001 behind it
```

Open `http://localhost:18473/`. `supatype dev` starts Next too and serves it at `/`.

Next reads `.env.local` only when it starts, so add the key before `supatype dev`.

To publish a post, sign in to Studio at `http://localhost:18473/studio/` with an admin:

```bash
pnpm exec supatype admin create-user --email you@example.com --password <password> --role admin
```

## Checked in CI

`bash tests/integration/scripts/blog-e2e.sh` (from the monorepo root) starts the stack and Next,
then reads the HTML of `/` to prove the post list was rendered on the server from the API, checks
`/login` and `/signup` answer through the gateway, and calls `greet`.
