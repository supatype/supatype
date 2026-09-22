# Kitchen sink

Every Supatype feature in one project, arranged so you can read it.

A conference. The **marketing site** sells it — pages, speakers, talks, sponsors, published by an
editor and read by anyone. The **app** is what an attendee signed in to — their ticket, their
schedule, the lobby chat. Two front ends, one schema, one stack.

The split is the point. One app rendered twice would cover the same API surface and teach nothing;
these two want genuinely different features. The marketing half is content-shaped: server
rendering, SEO, translations, drafts, publishing, blocks. The app half is session-shaped: auth,
realtime, storage uploads, per-row access, functions.

## Status

**Everything described below is in the tree**: the schema, the generated types, both front ends,
the edge functions, two field validators, the seed, the headless verify and the CI job that runs it
against a live stack.

**What has not happened is the running.** That CI job is dispatch-gated like the other live-stack
jobs, so it has never executed; every claim here is backed by code that typechecks and builds, and
by assertions written to fail loudly, but not yet by a green run. The first dispatch or scheduled
run is where that changes.

`apps/app` (Vite SPA, `app.mode = "static"`) is the session-shaped half: auth through
`@supatype/react-auth`'s prebuilt forms, `useQuery` against the published schedule, and in the
lobby all three realtime paths — `postgres_changes` for what was written down, presence for who is
here now, broadcast for a "typing…" that is deliberately not a row. The ticket screen covers
per-row access (`OwnerFrom` with no client-side filter), `useFunction` for work this client cannot
do (issuing gates on your token then writes with the service role), and a signed URL into a
private bucket, which a public URL cannot reach. The media screen covers storage: upload, then the
same object read back both as uploaded and transformed on read. The rules screen meets all three
ways of refusing a value — a bound, a model constraint and a validator — on a model a signed-in
caller may actually write, because a refusal nobody can trigger teaches nothing about how they
differ.

The storage and signed-URL paths close a gap nothing in this repository covered: `blog` declares
buckets and never uploads, so before this the runtime path was typechecked and never run.

`apps/marketing` (Next.js, `app.mode = "proxy"`) is the content-shaped half: `@supatype/ssr`
reading the caller's session off request cookies, a home page assembled from the schema's block
vocabulary, a talks listing and a talk page whose `generateMetadata` builds real `og:` tags with an
image transformed on read, the same read again through a Route Handler, and middleware picking the
reader's locale on the edge — which the talk page then honours, rendering an untranslated abstract
as *absent* rather than silently falling back to English.

`/preview/[slug]` covers both things called preview, because they answer different questions: the
**saved draft**, read on the server with `.draft()` and a preview code that is the whole credential,
and **unsaved keystrokes**, streamed from an open Studio tab by `useLivePreview`. Nothing else in
this repository exercises the second.

Every route is dynamic on purpose — an editor previewing a draft and a reader seeing only what is
live are the same code path, distinguished by who the request is from, which a static build cannot
do.

Each screen and route states the surface it proves; one that cannot is not worth having.

## The `app.mode` constraint

`app` is a single object with one `mode`, and the server serves one thing at `/`, so the two apps
take turns rather than running side by side. That is a feature to prove, not a problem to route
around.

Three scripts switch between them, and each is a real `supatype app` invocation rather than a
config edit of our own:

```bash
pnpm mode:app         # supatype app add --static ./apps/app/dist
pnpm mode:marketing   # supatype app add --upstream http://host.docker.internal:3006
pnpm mode:none        # supatype app remove
```

**They rewrite `supatype.config.ts` in place**, because that is what the command does. Expect a
dirty config after switching, and do not commit it unless you meant to. The committed default is
the SPA, because that is the deployment most projects ship.

`tests/integration/scripts/kitchen-sink-e2e.sh` walks that in CI: `static` serves the SPA and a
path with no file behind it falls back to the shell, `none` returns 404 while the API keeps
answering, and switching back works. `proxy` is not in the walk yet — it needs `next dev` beside
the stack and a `host.docker.internal` that resolves on a Linux runner, the same pair that gates
`blog-e2e` — so `pnpm mode:marketing` is how you exercise it locally.

## What the schema covers

| | |
|---|---|
| Primitives | `UUID`, `Slug`, `RichText`, `Markdown`, `Currency`, `Decimal`, `Int`, `DateOnly`, `Timestamp`, `Duration`, `Email`, `URL`, `PhoneNumber`, `Color`, `JSON<T>`, `GeoPoint`, `Vector`, `Button` |
| Modifiers | `Optional`, `Unique`, `Indexed`, `Searchable`, `MaxLength`, `MaxItems`, `Between`, `ComputedFrom` |
| Localization | `LocaleConfig<["en","fr"],"en">`, `Localized`, `NotLocalized` |
| Blocks | `Block` / `Blocks` — a closed vocabulary of page sections, not a rich-text column |
| Buckets | public (headshots), private (ticket PDFs), custom + role (sponsor artwork) |
| Access | `Public`, `LoggedIn`, `Owner`, `OwnerFrom`, `Role`, and `Lte<"published_at", Now>` as the read rule |
| Constraints | `Lte<"starts_at","ends_at">` on `Talk` and `Gte<Length<"body">, Literal<2>>` on `ChatMessage`, plus a composite index |
| Publishing | `versions: { drafts, keep }` on `Page`, `Speaker` and `Talk` |
| Singleton | `SiteSettings`, one row, edited in Studio |

`functions/` holds two edge functions: `ping`, which cannot fail for its own reasons and so tells
you the worker itself is wrong, and `issue-ticket`, which gates on the caller's own token and then
writes with the service role — issuing is server work even though reading a ticket is the owner's.

`hooks/` holds two validators — the third way to refuse a value, and the only one that can name the
field back to the caller. `validate-talk-title` guards an editor-written field;
`validate-chat-body` guards one an attendee writes, which is what lets the app's rules screen
trigger all three refusals rather than describing them. Bounds and constraints hold for every
writer including `psql`; a validator runs on the API write path only, so both are rules a `CHECK`
genuinely cannot express.

Two things are still absent, both for reasons outside this example:

- the `plugin-seo` composite, because schema-side plugin registration needs a spike first
- a publish button, because `supatype.publish(table, id)` is documented in `@supatype/types` and
  implemented nowhere — the client exposes `.draft()` for reading but nothing for publishing, so
  publishing happens in Studio and this example reads the result

`Searchable` is here in both its spellings — the modifier on `Speaker.name`, the ordered model-level
list on `Talk` — and building this example is what turned up the fact that the CLI was discarding
it. That is fixed; the last link, the engine forwarding it into `admin-config.json`, ships
separately, so a search box in Studio needs an engine carrying it.

## Running it

```bash
pnpm install
pnpm keys            # mints ANON_KEY / SERVICE_ROLE_KEY into .env
pnpm build:app       # app.mode is "static", so the SPA must exist before the stack serves it
pnpm dev             # Postgres, the schema, the whole stack
```

Then, in another terminal:

```bash
pnpm seed            # one page, one speaker, two talks (one published), one sponsor
pnpm verify          # the assertions a browser cannot make
```

The marketing site runs beside the stack rather than inside it:

```bash
pnpm mode:marketing && pnpm build:marketing
pnpm --filter @supatype/example-kitchen-sink-marketing dev
```

`pnpm typecheck` covers all three TypeScript projects here — the schema and scripts, `functions/`,
and `hooks/` — because the Deno-typed directories need their own configs and a config nobody runs
checks nothing.
