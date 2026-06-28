# REST GET caching

Opt-in caching for PostgREST table reads (`GET /rest/v1/*`). Two layers:

| Layer | Storage | Scope | Availability |
|-------|---------|--------|--------------|
| **Client** | In-memory (`@supatype/client`) | Same browser tab / Node process | All deployments |
| **Server** | Valkey | All users, tabs, and replicas (when `public`) | **Self-host** + **paid Cloud**; not Cloud free tier |

Server cache requires **Valkey** (self-host compose, native `supatype dev` sidecar, per-project Valkey on paid Cloud). On **Cloud free tier**, server cache is disabled (`rest_cache_enabled: false`); client `.cache({ ttl })` without `server: true` still works.

**Default:** all tables are **uncached** until enabled in admin config (`cache_tables`) with `cache_max_ttl > 0` (where server cache is offered).

## Client SDK

```typescript
// Client memory only — all tiers
const { data } = await supatype
  .from("posts")
  .select("id, title")
  .cache({ ttl: 30_000 }) // milliseconds

// Server Valkey cache (paid Cloud + self-host; table must be allowlisted)
const { data } = await supatype
  .from("posts")
  .select()
  .cache({ ttl: 30_000, server: true })

// Shared across users when table has allow_public
const { data } = await supatype
  .from("posts")
  .select()
  .cache({ ttl: 30_000, server: true, public: true })
```

`meta.cacheStatus` on the result is `"HIT"`, `"MISS"`, or `"BYPASS"` when caching is active.

### React

```tsx
const { data, loading } = useQuery("posts", {
  filter: { status: "published" },
  cache: { ttl: 60_000, server: true, public: true },
})
```

## Server configuration

Per-table allowlist in `api-config.json` (only when server cache is offered):

```json
{
  "rest": {
    "schema": "public",
    "max_rows": 1000,
    "cache_max_ttl": 300,
    "cache_tables": {
      "posts": { "enabled": true, "allow_public": true },
      "profiles": { "enabled": true, "allow_public": false }
    }
  }
}
```

Patch via Studio or `PATCH /admin/v1/config/rest` (returns `403 rest_cache_not_available` on Cloud free tier).

Effective TTL = `min(client max-age, cache_max_ttl)`.

### Cache key scope

| Client `public` | Table `allow_public` | Key identity |
|-----------------|----------------------|--------------|
| yes | yes | Global (shared) |
| yes | no | Per user (`role:sub` from JWT) |
| no | any | Per user (`role:sub`) |

Keys survive JWT refresh (same `sub`).

### Response headers

- `X-Supatype-Cache-Status: HIT | MISS | BYPASS`
- `Age: N` on cache hits

## CLI

```bash
supatype cache rest list
supatype cache rest list --table posts
supatype cache rest get "tenant:local:rest:..."
supatype cache rest delete "tenant:local:rest:..."
supatype cache rest flush --yes
supatype cache rest flush --table posts --yes
```

Admin cache API is unavailable on Cloud free tier.

## Studio

- **Models → Cache** — per-table entries and settings (paid Cloud + self-host)
- **API → REST → Cache** — browse / flush
- **API → REST → Settings** — global `cache_max_ttl`

Cloud free projects see an upgrade notice; client-only caching remains available.

## Security

- Tables uncached by default; client cannot force server cache without allowlist + TTL cap + tier eligibility.
- `public: true` only honored when `allow_public` is set on the table.
- Only `GET` / `HEAD` with 2xx responses are cached.
- **v1 invalidation:** TTL only.

## Infrastructure

- **Self-host:** Valkey in `supatype self-host compose` stack; `SUPATYPE_VALKEY_ADDR` on server.
- **Cloud paid:** per-project Valkey (target); `tenant:{ref}:config.rest_cache_enabled: true`.
- **Cloud free:** server bypasses Valkey REST cache regardless of client `server: true`.

If Valkey is unavailable, server cache **bypasses**. Client in-memory cache still works.

## Architecture

See `plans/Cloud-Tenant-Gateway-Architecture.md` for platform vs tenant gateway and Valkey key layout.
