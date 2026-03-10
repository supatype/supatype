# Claude Code Instructions — Supatype (definatype monorepo)

## Plans

Always look for active plan files in `C:\Users\Nic_J\Documents\NJ\plans\` (one directory above this repo root: `../plans` relative to `definatype/`). Before starting any implementation work, check that directory for an existing plan file that applies to the current task and follow it.

Available plans: Phase-00 through Phase-24 plus deep-architecture-spec.md.

## Project structure

- Turborepo + pnpm workspaces
- `packages/schema` — `@supatype/schema` builder API
- `packages/client` — `@supatype/client` typed HTTP client
- `packages/react` — `@supatype/react` React hooks
- `packages/cli` — `@supatype/cli` CLI binary
- `plans/` — Phase planning docs (Phase-00 through Phase-10 + deep-architecture-spec.md)

## TypeScript conventions

- `exactOptionalPropertyTypes: true` — use conditional spread `...(x !== undefined && { key: x })`
- `lib: ["ES2022", "DOM"]` for client/react packages (native fetch, localStorage)
- `jsx: "react-jsx"` for the react package
- All packages are ESM

## Commands

- `pnpm build` — turbo pipeline build
- `pnpm turbo run typecheck` — typecheck all packages
- `pnpm --filter @supatype/<pkg> test` — run tests for a package
