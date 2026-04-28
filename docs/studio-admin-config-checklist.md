# Studio AdminConfig — implementation checklist

Single JSON shape (**AdminConfig**) everywhere; generation via engine **`POST /admin`** with the schema AST.

## Source of truth

| Environment | Studio reads | Written when |
|-------------|--------------|--------------|
| **Cloud** (all tiers: free, pro, team, enterprise) | `GET …/projects/:slug/config` → `cloud.projects.schema_config` | After **`POST …/schema/push`** succeeds: `engineAdmin(ast)` → `UPDATE cloud.projects SET schema_config` |
| **Self-host / local** | `POST {Kong}/studio-config` → engine reads `_platform.migrations.admin_config` | Engine **`/push`** inserts **`admin_config`** on applied migrations |

Cloud Studio must **not** rely on reading `admin_config` from shared tenant Postgres for free tier; the control-plane column is authoritative.

## Cloud gaps (tracked)

- [x] Persist **`schema_config`** on successful schema push (all tiers) — `engineAdmin` + `UPDATE cloud.projects` in [`schema.ts`](../../supatype-cloud/src/routes/schema.ts).
- [ ] **Enterprise BYO DB** — if projects get a custom `database_url`, extend `resolveProjectDbUrl` (not in scope unless product ships it).
- [ ] **Infra** — align `postgres.project-{ref}` (schema routes) with provisioner `postgres-{ref}` hostnames if push fails in K8s.

## Self-host gaps (tracked)

- [x] Studio **`main.tsx`** fetches **`/studio-config`** with actionable errors + optional demo mode (`sessionStorage`).
- [x] Cloud Studio: **`projectConfigError`** + shared **`StudioConfigError`** (Retry reload; no demo button).
- [x] **Kong auth** for `/sql` and `/studio-config` — `buildKongDeclarative` + `STUDIO_GATEWAY_KEY` / `VITE_STUDIO_GATEWAY_KEY`; Studio sends `apikey` when set.

## UI alignment (reference shells)

- [x] Deeper **`--canvas`** main area, **`--card`** chrome tweak, sidebar active **left accent**, wider nav (268px), TopBar **Studio / Main** branch pill + **Demo** badge when applicable.
- [ ] Full split **icon rail + text panel** as two columns (optional follow-up; active stripe + width bump landed first).

## Tier notes

- **Pro / team / enterprise**: Same as each other in `resolveProjectDbUrl` (dedicated DB, `public` schema); same **`schema_config`** behavior as free for Studio.
- **Free**: Shared DB + project schema; **`schema_config`** still per project row in control plane.

## Related files

- Control plane: [`../../supatype-cloud/src/routes/schema.ts`](../../supatype-cloud/src/routes/schema.ts), [`../../supatype-cloud/src/services/engine-client.ts`](../../supatype-cloud/src/services/engine-client.ts)
- Projects API: [`../../supatype-cloud/src/routes/projects.ts`](../../supatype-cloud/src/routes/projects.ts) (`GET/PUT …/config`)
- Engine: `supatype-schema-engine` — `/admin`, `/push`, `/studio-config`
- Studio package: [`../packages/studio/src/main.tsx`](../packages/studio/src/main.tsx), [`../packages/studio/src/components/StudioConfigError.tsx`](../packages/studio/src/components/StudioConfigError.tsx)
