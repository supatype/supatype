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

**The schema is in. The two front ends are not yet.** This directory currently holds the project —
`supatype.config.ts`, `schema/index.ts` — and nothing that runs against it. That is deliberate: the
apps import generated types, and the types come from the schema, so the schema goes first and gets
verified on its own.

What lands next, in order: the generated types (committed, so the drift check in CI covers them),
`apps/app` (Vite SPA, `app.mode = "static"`), then `apps/marketing` (Next.js, `app.mode = "proxy"`),
then the edge functions, the seed, and the verify scripts.

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

Two things are deliberately absent until they can be shown working: the `plugin-seo` composite
(schema-side plugin registration needs a spike first) and a per-field `validate` hook (it wants its
`hooks/` function alongside it, which lands with the functions).

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
