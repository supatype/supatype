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

`apps/app` (Vite SPA, `app.mode = "static"`) is the session-shaped half, and it is organised by
what an attendee does rather than by which API each screen exercises. **Programme** groups the
published talks by day with their speaker, room and abstract; **Speakers** is the grid of who is
talking; **Lobby** is the chat; **My ticket** is a ticket; **Sponsors** is who paid for the coffee;
**Account** is where you change your picture.

That reorganisation is the point rather than decoration. The screens used to be named after the
surfaces they covered, including a **Media** tab that was a file input and a **Rules** tab that was
three API descriptions with a *Try it* button beside each, under a `Proves: useQuery, relations,
ordering` caption wedged into the navigation. It covered the same API and read as a test fixture,
which is a poor advertisement for building anything with this. The explanation is still here,
behind a **What this demonstrates** control on each screen, because reading the example is the
point; it is simply no longer the chrome.

The same surfaces are all still exercised, in the places an attendee would meet them. `useQuery`
and relations build the programme. All three realtime paths are in the lobby: `postgres_changes`
for what was written down, presence for who is here now, broadcast for a "typing…" that is
deliberately not a row. Per-row access is the ticket (`OwnerFrom` with no client-side filter),
alongside `useFunction` for work this client cannot do and a signed URL into a private bucket that
a public URL cannot reach. Storage upload and transform-on-read are the profile picture. And the
three ways of refusing a value are met by writing a message the schema will not accept, where the
difference between them is visible: a bound and a constraint come back as database errors, while
the validator names the field and says what to change.

Every screen is built from `src/components/ui.tsx`, and no screen writes CSS of its own. The
previous version hand-rolled markup against a stylesheet that had grown a class per view, so five
screens had five type scales and no shared idea of a card.

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
| Caching | `cache: { enabled, maxTtl, public, rows }` on seven models, and deliberately absent on the eighth |
| Singleton | `SiteSettings`, one row, edited in Studio |

The cache declaration is on the model because that is the only place both halves of the decision
are visible at once. `public` shares one entry with every caller, so it is correct for `Talk`,
`Page`, `Speaker`, `Sponsor` and `Room`, whose read rules depend on a column and the clock but
never on who is asking, and it is a data leak on `Ticket`, whose `OwnerFrom` rule answers
differently per caller. `supatype push` refuses that pairing by name rather than leaving it to be
noticed in production, and the admin API refuses it again at runtime.

**`ChatMessage` declares no cache, and that is the entry worth reading.** It is the table the lobby
subscribes to: a response cache in front of a feed whose whole value is being current would serve a
stale list while the socket delivers the row contradicting it. A model with no `cache` block cannot
be cached by Studio, the admin API or anyone, so leaving it out is a decision the schema records
rather than something nobody got round to.

Declarations are ceilings, never settings. `Talk` caps at 120 seconds; Studio can lower that or
switch the table off mid-incident, and can never raise it or cache a model that declared nothing.

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
cp .env.example .env # `supatype keys` needs a JWT_SECRET; it does not invent one
pnpm keys            # mints ANON_KEY / SERVICE_ROLE_KEY into .env
pnpm build:app       # app.mode is "static", so the SPA must exist before the stack serves it
pnpm dev             # Postgres, the schema, the whole stack
```

The `.env` copy is not optional and the order is not arbitrary. `supatype keys` reads
`JWT_SECRET` and fails without one, and the SPA reads `VITE_SUPATYPE_ANON_KEY` at **build**
time, so a build that runs before the keys exist ships `anonKey: undefined` and every request
it makes is rejected by the gateway. Rebuild after re-minting keys.

Then, in another terminal:

```bash
pnpm seed            # one page, one speaker, two talks (one published), one sponsor
pnpm verify          # the assertions a browser cannot make
```

The marketing site runs beside the stack rather than inside it:

```bash
cp apps/marketing/.env.local.example apps/marketing/.env.local
# paste ANON_KEY from .env into NEXT_PUBLIC_SUPATYPE_ANON_KEY
pnpm mode:marketing && pnpm build:marketing
pnpm --filter @supatype/example-kitchen-sink-marketing dev
```

Next.js reads `apps/marketing/.env.local`, not the project root, and the CLI only writes
`VITE_`, `PUBLIC_` and `EXPO_PUBLIC_` names, so that paste is manual. Skipping it leaves
`anonKey` as the empty string, which reads as an anonymous caller with no key at all.

`pnpm typecheck` covers all three TypeScript projects here — the schema and scripts, `functions/`,
and `hooks/` — because the Deno-typed directories need their own configs and a config nobody runs
checks nothing.
