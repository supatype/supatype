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

**Both front ends are in.** What is not yet: the mode-switch scripts, the edge functions, the seed
and the verify scripts.

`apps/app` (Vite SPA, `app.mode = "static"`) is the session-shaped half: auth through
`@supatype/react-auth`'s prebuilt forms, `useQuery` against the published schedule, realtime
INSERTs in the lobby, a ticket reachable only by its owner, and storage — upload, then the same
object read back both as uploaded and transformed on read. The storage screen closes a gap nothing
in this repository covered: `blog` declares buckets and never uploads, so before it the runtime
path was typechecked and never run.

`apps/marketing` (Next.js, `app.mode = "proxy"`) is the content-shaped half: `@supatype/ssr`
reading the caller's session off request cookies, a home page assembled from the schema's block
vocabulary, a server-rendered talks listing, the same read again through a Route Handler, and
middleware that picks the reader's locale on the edge. Every route is dynamic on purpose — an
editor previewing a draft and a reader seeing only what is live are the same code path,
distinguished by who the request is from, which a static build cannot do.

Each screen and route states the surface it proves; one that cannot is not worth having.

## The `app.mode` constraint

`app` is a single object with one `mode`, and the server serves one thing at `/`, so the two apps
take turns rather than running side by side. That is a feature to prove, not a problem to route
around: `verify:modes` will assert `static` serves the SPA with fallback routing, `proxy` serves the
marketing site with its tags rendered server-side, and `none` returns 404.

Day to day, `dev:app` and `dev:marketing` will write `supatype.local.config.ts` — gitignored and
deep-merged — to pick which one you are working on. The committed default is the SPA, because that
is the deployment most projects ship.

## What the schema covers

| | |
|---|---|
| Primitives | `UUID`, `Slug`, `RichText`, `Markdown`, `Currency`, `Decimal`, `Int`, `DateOnly`, `Timestamp`, `Duration`, `Email`, `URL`, `PhoneNumber`, `Color`, `JSON<T>`, `GeoPoint`, `Vector`, `Button` |
| Modifiers | `Optional`, `Unique`, `Indexed`, `Searchable`, `MaxLength`, `MaxItems`, `Between`, `ComputedFrom` |
| Localization | `LocaleConfig<["en","fr"],"en">`, `Localized`, `NotLocalized` |
| Blocks | `Block` / `Blocks` — a closed vocabulary of page sections, not a rich-text column |
| Buckets | public (headshots), private (ticket PDFs), custom + role (sponsor artwork) |
| Access | `Public`, `LoggedIn`, `Owner`, `OwnerFrom`, `Role`, and `Lte<"published_at", Now>` as the read rule |
| Constraints | `Lte<"starts_at","ends_at">` on `Talk`, plus a composite index |
| Publishing | `versions: { drafts, keep }` on `Page`, `Speaker` and `Talk` |
| Singleton | `SiteSettings`, one row, edited in Studio |

`functions/` holds two edge functions: `ping`, which cannot fail for its own reasons and so tells
you the worker itself is wrong, and `issue-ticket`, which gates on the caller's own token and then
writes with the service role — issuing is server work even though reading a ticket is the owner's.

`hooks/validate-talk-title` is the third way to refuse a value, and the only one that can name the
field back to the caller. Bounds and constraints hold for every writer including `psql`; a
validator runs on the API write path only, so it is here for a rule a `CHECK` genuinely cannot
express.

One thing is still deliberately absent: the `plugin-seo` composite, because schema-side plugin
registration needs a spike first.

`Searchable` is here in both its spellings — the modifier on `Speaker.name`, the ordered model-level
list on `Talk` — and building this example is what turned up the fact that the CLI was discarding
it. That is fixed; the last link, the engine forwarding it into `admin-config.json`, ships
separately, so a search box in Studio needs an engine carrying it.

## Running it

```bash
pnpm install
pnpm --filter @supatype/example-kitchen-sink typecheck
```

`supatype dev` will start the stack once there is a front end for it to serve.
