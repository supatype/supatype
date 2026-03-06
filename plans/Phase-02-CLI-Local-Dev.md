# Phase 2 — CLI & Local Dev

> **Supatype** · Weeks 11–16 · March 2026 · Draft

---

## Overview

Deliver the developer-facing CLI that wraps the engine binary. A developer can initialise a project, start local infrastructure, define a schema in TypeScript, and push it to get a running API — all from the command line.

## Dependencies

Phase 1 complete — engine handles all common operations.

## Deliverable

`npx @supatype/cli init my-project && npx supatype dev && npx supatype push` works end-to-end. Developer has a running REST and GraphQL API.

## Task Breakdown

### CLI

| # | Task | Status |
|---|------|--------|
| 1 | @supatype/cli npm package — TypeScript CLI wrapping the engine binary, built with commander or oclif | ✓ |
| 2 | Binary download on postinstall — platform detection (darwin/linux, x64/arm64), CDN download, checksum verification, same pattern as Prisma/esbuild/SWC | ✓ |

### Commands

| # | Task | Status |
|---|------|--------|
| 3 | `init` command — scaffold project directory, generate supatype.config.ts, schema/, .env, docker-compose.yml, seed.ts | ✓ |
| 4 | `dev` command — start Docker Compose (Postgres, PostgREST, Kong, pg_graphql), wait for health checks, watch schema files for changes | ✓ |
| 5 | `push` command — load schema files → run serialiser → engine parse → diff against DB → prompt for destructive changes → apply migration → generate types | ✓ |
| 6 | `diff` command — dry run of push, shows planned changes without applying | ✓ |
| 7 | `pull` command — introspect existing Postgres DB → generate TypeScript schema files with sensible defaults and TODO comments for access rules | ✓ |
| 8 | `generate` command — regenerate TypeScript types without running a migration | ✓ |
| 9 | `migrate`, `rollback`, `reset` commands — apply pending migrations, rollback last migration, reset DB to clean state | ✓ |
| 10 | `seed` command — run seed.ts file with ts-node or tsx against the database | ✓ |

### Config

| # | Task | Status |
|---|------|--------|
| 11 | supatype.config.ts — configuration loading for DB connection, schema paths, output paths, engine options | ✓ |

### Infra

| # | Task | Status |
|---|------|--------|
| 12 | PostgREST Docker image + auto-configuration — generate postgrest.conf from schema, configure in docker-compose.yml | ✓ |
| 13 | pg_graphql extension setup — enable extension, configure Kong route /graphql/v1 | ✓ |

### Testing

| # | Task | Status |
|---|------|--------|
| 14 | Verify PostgREST REST endpoints work with generated schema | ○ |
| 15 | Verify pg_graphql GraphQL endpoint works with generated schema | ○ |

## Technical Context

- The CLI is TypeScript (not Rust) — it orchestrates the engine binary, Docker, and file generation. The engine binary is called as a subprocess with JSON over stdin/stdout.
- Docker Compose stack for local dev: Postgres 16 (with extensions), PostgREST, Kong, pg_graphql (Postgres extension, no separate service), GoTrue (placeholder for Phase 3).
- Kong routes: /rest/v1/* → PostgREST (port 3000), /graphql/v1 → pg_graphql (Postgres port 5432 via Kong plugin), /auth/v1/* → GoTrue (port 9999), /storage/v1/* → Storage (port 5000).
- The pull command enables migration from existing Postgres databases. It generates TypeScript schema files with best-effort type mapping, scaffolded access rules (access.authenticated() for all operations), and TODO comments for manual review.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Docker Compose startup reliability across platforms (macOS Docker Desktop, Linux native, WSL) | Extensive health check polling with clear error messages; document minimum Docker versions |
| Binary download failures (corporate firewalls, China) | Support DEFINATYPE_ENGINE_PATH env var for manual binary placement; mirror on multiple CDNs |
| pg_graphql version compatibility with Postgres | Pin pg_graphql version in Docker image; test against target Postgres versions |

## Success Criteria

Phase 2 is complete when:

- [x] `npx @supatype/cli init` creates a valid project scaffold
- [ ] `npx supatype dev` starts all services and passes health checks within 30 seconds
- [ ] `npx supatype push` migrates DB and generates types for a multi-model schema
- [ ] PostgREST serves correct CRUD endpoints for generated tables
- [ ] pg_graphql serves correct GraphQL schema reflecting the data model
- [ ] `npx supatype pull` generates valid schema files from an existing DB
