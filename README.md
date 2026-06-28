<p align="center">
   <img src="https://raw.githubusercontent.com/supatype/.github/refs/heads/main/profile/supatype-icon.svg" width="80" alt="Supatype" />
</p>

# Supatype

**Type-first platform for PostgreSQL** — define `Model<…>` types in TypeScript; migrations, RLS, API, Studio CMS, and client bindings follow.

**Product overview:** [github.com/supatype](https://github.com/supatype) · **Docs:** [supatype.github.io/supatype](https://supatype.github.io/supatype/)

This monorepo ships **`@supatype/cli`**, **`@supatype/types`**, **`@supatype/client`**, **`@supatype/react`**, **`@supatype/studio`**, storage, realtime, and related packages.

User guides: [local dev](https://supatype.github.io/supatype/#local-dev) · [self-host](https://supatype.github.io/supatype/#self-host)

---

## Deployment modes (summary)

| Mode | Command | Postgres | Everything else |
|------|---------|----------|-----------------|
| **Dev** | `supatype dev` | Native (default) or **Docker for Postgres only** | Native **engine** + **supatype-server** binaries |
| **Self-host** | `supatype self-host compose up` | Docker (`supatype/postgres:17-latest`) | **Docker Compose** — images default to **`:latest`** on Docker Hub |

---

## Monorepo development

```bash
pnpm install
pnpm dev:local    # CLI against tests/integration fixture
pnpm build
pnpm turbo run typecheck
pnpm --filter @supatype/cli test
```

For full app fixtures, see `examples/self-host/` or `examples/blog/`.

Overrides: `supatype.local.config.ts` beside `supatype.config.ts` (gitignored, deep-merged for local dev).

---

## Schema workflow

```bash
supatype diff
supatype push
supatype generate
```

---

## Binary cache (dev)

```bash
supatype update
supatype cache list
```

Components download from `https://releases.supatype.com`.
