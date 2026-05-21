<p align="center">
   <img src="https://raw.githubusercontent.com/supatype/.github/refs/heads/main/profile/supatype-icon.svg" width="80" alt="Supatype" />
</p>

# Supatype

**Schema-first backend for PostgreSQL** — TypeScript models, generated migrations, RLS, and a unified API gateway (**supatype-server**).

This monorepo ships **`@supatype/cli`**, **`@supatype/client`**, **`@supatype/react`**, Studio, storage, and realtime packages.

**Documentation for users:** [GitHub Pages](https://supatype.github.io/supatype/) — local dev and self-host guides live there (`#local-dev`, `#self-host`).

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
pnpm supatype init
pnpm supatype dev
```

Overrides: `supatype.local.config.ts` beside `supatype.config.ts`.

```bash
pnpm build
pnpm turbo run typecheck
pnpm --filter @supatype/cli test
```

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
