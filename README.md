<p align="center">
   <img src="https://raw.githubusercontent.com/supatype/.github/refs/heads/main/profile/supatype-icon.svg" width="80" alt="Supatype" />
</p>

# Supatype

**Zero drift.**

Postgres, migrations, row-level security, API, realtime, storage, Studio and the typed client your components use, all from the TypeScript you already write. Change a field once. Nothing else to update.

One set of types runs your whole stack, database to component. Rename a field and the build fails instead of production.

**Website & docs:** [supatype.com](https://www.supatype.com/) · **Org overview:** [github.com/supatype](https://github.com/supatype) · **Discord:** [discord.gg/TzMtynufEH](https://discord.gg/TzMtynufEH)

User guides: [docs](https://www.supatype.com/docs/) · [local dev](https://www.supatype.com/docs/#local-dev) · [self-host](https://www.supatype.com/docs/#self-host) · [deploy to a VM with GitHub Actions](https://www.supatype.com/deploy-vm-github-actions.html)

---

## Quick start

```bash
npm install -g @supatype/cli
mkdir my-app && cd my-app
supatype init
supatype keys
supatype dev
```

Then edit your schema and apply it:

```bash
supatype diff       # preview the migration
supatype push       # apply migrations, RLS and generated types
supatype generate   # regenerate types and clients only
```

---

## Deployment modes

| Mode | Command | Postgres | Everything else |
|------|---------|----------|-----------------|
| **Dev** | `supatype dev` | Native (default) or **Docker for Postgres only** (`database.provider: "docker"`) | Native **engine** + **supatype-server** binaries |
| **Self-host** | `supatype self-host compose up` | Docker (`supatype/postgres:17-latest`) | **Docker Compose**, images default to **`:latest`** on Docker Hub |
| **Cloud** | `supatype login`, `supatype link`, `supatype deploy` | Managed | Supatype Cloud (early access) |

---

## Packages

Every package consumes the same generated types; nothing in your app introspects the database after the fact or keeps its own copy of the model.

| Package | What it is |
|---------|------------|
| [`@supatype/cli`](packages/cli) | The `supatype` CLI: init, dev, diff, push, generate, introspect, migrate, self-host, functions |
| [`@supatype/types`](packages/types) | Type primitives for schemas: `Model<…>`, field types, relations, access rules, `Bucket<…>` |
| [`@supatype/client`](packages/client) | Typed client: REST, auth, storage, realtime |
| [`@supatype/react`](packages/react) | React hooks: `useQuery`, `useMutation`, `useAuth`, `SupatypeProvider` |
| [`@supatype/react-auth`](packages/react-auth) | Pre-built auth UI for React |
| [`@supatype/react-native`](packages/react-native) | React Native client, secure session storage, PKCE OAuth deep links |
| [`@supatype/react-native-auth`](packages/react-native-auth) | Pre-built auth UI for React Native |
| [`@supatype/vue`](packages/vue) | Vue composables |
| [`@supatype/svelte`](packages/svelte) | Svelte stores |
| [`@supatype/solid`](packages/solid) | Solid primitives |
| [`@supatype/ssr`](packages/ssr) | Cookie-based auth for server components, route handlers and middleware |
| [`@supatype/plugin-sdk`](packages/plugin-sdk) | Build custom field types, composites, providers and Studio widgets |
| [`@supatype/plugin-seo`](packages/plugin-seo), [`plugin-color-picker`](packages/plugin-color-picker), [`plugin-phone-field`](packages/plugin-phone-field) | First-party plugins |
| [`@supatype/ui`](packages/ui), [`@supatype/common`](packages/common) | Shared UI components and web-app utilities |

Services (shipped as images, not npm libraries): [`studio`](packages/studio) (admin panel and CMS), [`storage`](packages/storage), [`realtime`](packages/realtime), [`functions-worker`](packages/functions-worker) (Deno edge functions).

---

## Examples

[`examples/`](examples/) has runnable projects. **Start with [`kitchen-sink`](examples/kitchen-sink/)** for a tour of nearly every feature, or [`blog`](examples/blog/) for something small to copy. The [examples index](examples/README.md) lists the rest (Expo auth, edge functions, realtime, validation, self-host).

---

## Agent skill

[`skills/supatype/`](skills/supatype/) is an agent skill that teaches coding agents the Supatype schema and CLI. It installs as a plugin for Claude Code and Cursor; see [`plugins/README.md`](plugins/README.md).

---

## Monorepo development

Turborepo + pnpm workspaces. All packages are ESM.

```bash
pnpm install
pnpm dev:local    # CLI against the tests/integration fixture
pnpm build
pnpm turbo run typecheck
pnpm --filter @supatype/cli test
```

Overrides: `supatype.local.config.ts` beside `supatype.config.ts` (gitignored, deep-merged for local dev).

### Binary cache

The CLI downloads the schema engine and `supatype-server` from `https://releases.supatype.com` and caches them.

```bash
supatype update
supatype cache list
```

---

## License

Licensing is per package, and each package directory has its own `LICENSE` file:

- **MIT:** the libraries you install in your app: `client`, `types`, the framework bindings (`react`, `react-native`, `vue`, `svelte`, `solid`), `ssr`, the auth UI packages, the plugin packages, `ui` and `common`.
- **Apache 2.0:** the CLI and services (`cli`, `studio`, `storage`, `realtime`) and the rest of this repository ([LICENSE](LICENSE)).

The schema engine binary the CLI downloads is not in this repository and is distributed under its own proprietary license. See [NOTICE](NOTICE).
