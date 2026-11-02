# REST GET caching

Opt-in caching for PostgREST table reads (`GET /rest/v1/*`). Two layers:

| Layer | Storage | Scope | Availability |
|-------|---------|--------|--------------|
| **Client** | In-memory (`@supatype/client`) | Same browser tab / Node process | All deployments |
| **Server** | A RESP keyspace | All users, tabs, and replicas (when `public`) | **Self-host** + **paid Cloud**; not Cloud free tier |

Server cache needs a RESP keyspace to store responses in. Which one depends on the deployment: `pg_keyspace` inside the project's own Postgres, or a Valkey server. Nothing above this line changes with the answer. On **Cloud free tier**, server cache is disabled (`rest_cache_enabled: false`); client `.cache({ ttl })` without `server: true` still works.

**Default:** nothing is cached on the server until a model [declares `cache`](#declaring-a-cache-on-a-model).

## Client SDK

```typescript
// Client memory only, on every tier
const { data } = await supatype
  .from("posts")
  .select("id, title")
  .cache({ ttl: 30_000 }) // milliseconds

// Server-side cache (paid Cloud + self-host; the model must declare a cache)
const { data } = await supatype
  .from("posts")
  .select()
  .cache({ ttl: 30_000, server: true })

// Shared across users, when the model declares `public: true`
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

## Declaring a cache on a model

A model with no `cache` block cannot be cached by anyone: not the client, not Studio, not the admin
API. Opt in in the model's options:

```typescript
export type Post = Model<{
  id: UUID
  title: string
  published_at: Optional<Timestamp>
}, {
  access: { read: Lte<"published_at", Now> }
  cache: { enabled: true, maxTtl: 60, public: true }
}>
```

- `enabled`: the model's reads may go in the server's response cache.
- `maxTtl`: the longest, in seconds, a response may be held.
- `public`: one entry is shared by every caller instead of one per user.

**The declaration is a ceiling.** Studio and the admin API can lower `maxTtl` or switch a table off,
for example during an incident, but cannot raise the cap or cache a model that declared nothing.

**`public: true` is refused where the read rule varies by caller.** A shared entry serves one
response to everyone, so on a model whose read rule depends on who is asking (`LoggedIn`, `Owner`,
`OwnerFrom`, `Role`), it would serve one user's rows to another. `supatype push` refuses that pairing
by name. A rule that varies by row or by time but not by caller, such as
`Lte<"published_at", Now>`, is fine.

## Server configuration

`supatype push` (and `supatype dev`) seed the runtime allowlist, `cache_tables` in
`.supatype/api-config.json`, from what the schema declares. A newly declared model gets an entry,
with `allow_public` following its `public`. A push never changes an entry that already exists, so a
table an operator narrowed stays narrowed:

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

`cache_max_ttl` is the project-wide cap, and `0` switches the server cache off. A push never sets it;
when it is `0` while models declare a cache, the push says so. Set it in Studio (API > REST >
Settings) or in the file.

Patch via Studio or `PATCH /admin/v1/config/rest` (returns `403 rest_cache_not_available` on Cloud free tier).

Effective TTL = `min(client max-age, cache_max_ttl, the model's maxTtl)`.

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

- **Models > Cache:** per-table entries and settings (paid Cloud + self-host)
- **API > REST > Cache:** browse and flush
- **API > REST > Settings:** global `cache_max_ttl`

Cloud free projects see an upgrade notice; client-only caching remains available.

## Security

- Nothing is cached on the server unless the model declares it; the client cannot force server cache past the declaration, the allowlist, the TTL cap and tier eligibility.
- `public: true` from the client is honoured only when `allow_public` is set on the table, which in turn needs the model's `public: true`.
- Only `GET` / `HEAD` with 2xx responses are cached.
- **v1 invalidation:** TTL only.

## Infrastructure

- **Self-host (compose):** `pg_keyspace` inside the `db` container by default, or a `valkey` service with `cache.provider = "valkey"` (which is also what `database.external` gets, since pg_keyspace needs a Postgres this stack starts). See [self-host.md](self-host.md).
- **Self-host (native `supatype dev`):** the keyspace in the Postgres it already starts, when the downloaded archive carries the library; a Valkey container beside it when not.
- **Cloud paid:** a keyspace per project; `tenant:{ref}:config.rest_cache_enabled: true`.
- **Cloud free:** the server bypasses the cache regardless of client `server: true`.

The response cache is ephemeral wherever it lives: restarting the store loses it, which costs a round trip to PostgREST and nothing else. If the store is unavailable entirely, server cache **bypasses** and the client in-memory cache still works.
