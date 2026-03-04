# Phase 0 — Foundations

> **Definatype** · Weeks 1–4 · March 2026 · Draft

---

## Overview

Prove the schema engine concept works end-to-end. By the end of this phase, a Rust binary can take a TypeScript schema definition, generate a Postgres migration, apply it, and output TypeScript types — the entire core loop validated against a real database.

## Dependencies

None — this is the starting point.

## Deliverable

A Rust binary that takes a TypeScript schema definition, generates a Postgres migration, and outputs TypeScript types. Tested against a local Postgres instance.

## Task Breakdown

### Engine

| # | Task | Status |
|---|------|--------|
| 1 | Set up Rust project structure (Cargo workspace with engine, ast, introspect, diff, generate crates) | ○ |
| 2 | Implement AST type definitions in Rust (Model, Field, Relation, Access, Composite, Index) | ○ |
| 3 | Implement JSON parser — read schema AST from stdin, deserialise to Rust types (serde_json) | ○ |
| 4 | Implement basic Postgres introspector — read tables, columns, constraints, indexes from information_schema and pg_catalog | ○ |
| 5 | Implement basic differ — detect new tables, new columns, dropped columns (no renames yet) | ○ |
| 6 | Implement basic SQL migration generator — CREATE TABLE, ALTER TABLE ADD/DROP COLUMN | ○ |
| 7 | Implement basic TypeScript type generator — interfaces for each model with correct field types | ○ |

### TypeScript

| # | Task | Status |
|---|------|--------|
| 8 | Set up @definatype/schema package — TypeScript field/model/relation builder functions | ○ |
| 9 | Implement serialiser — TypeScript runtime objects to JSON AST for engine consumption | ○ |

### Build

| # | Task | Status |
|---|------|--------|
| 10 | Cross-compile engine binary for macOS (arm64, x64) and Linux (x64, arm64) | ○ |

### Testing

| # | Task | Status |
|---|------|--------|
| 11 | Write integration test: define schema → generate migration → apply to Postgres → verify DB state matches | ○ |

## Technical Context

- The engine is a compiled Rust binary communicating via JSON over stdin/stdout. All commands (parse, introspect, diff, migrate, generate) follow this pattern.
- Key Rust crates: serde/serde_json (serialisation), tokio-postgres or sqlx (DB access), clap (CLI), similar (string similarity for future rename detection).
- The Cargo workspace should separate concerns: definatype-ast (types), definatype-introspect (Postgres reader), definatype-diff (differ), definatype-sql (SQL generator), definatype-ts (TypeScript generator), definatype-engine (CLI binary linking all crates).
- The @definatype/schema TypeScript package uses builder pattern with generic type inference — model() returns a typed builder, field.text() returns a TextFieldBuilder, etc. The serialiser walks the builder graph and emits JSON AST.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Rust learning curve if unfamiliar with ownership/lifetimes | Start with simple structs + serde; avoid complex lifetimes initially by cloning where needed |
| AST design locks in early — hard to change later | Keep AST extensible with optional fields and version number; design for forward compatibility |
| Cross-compilation toolchain complexity | Use cross-rs for Linux targets, native Cargo for macOS; set up CI early |

## Success Criteria

Phase 0 is complete when:

- [ ] Engine binary runs on macOS arm64 and Linux x64
- [ ] A 5-model schema (users, posts, comments, categories, tags) generates correct CREATE TABLE SQL
- [ ] Generated TypeScript interfaces compile without errors and match the schema
- [ ] Round-trip test passes: schema → migration → apply → introspect → verify
- [ ] Engine completes full pipeline in under 500ms for test schema
