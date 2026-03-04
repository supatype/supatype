# Phase 1 — Core Schema Engine

> **Definatype** · Weeks 5–10 · March 2026 · Draft

---

## Overview

Build the schema engine into a production-grade tool that handles all common schema operations reliably. This is the core product — everything else in the platform is integration around this engine.

## Dependencies

Phase 0 complete — basic engine pipeline working.

## Deliverable

A robust schema engine that handles real-world schema definitions and evolution, with 50+ test scenarios and comprehensive type/relation/migration support.

## Task Breakdown

### Types

| # | Task | Status |
|---|------|--------|
| 1 | Full field type support: text, integer, float, boolean, uuid, date, datetime, timestamp, json, jsonb, decimal, bigint, smallint, serial, bigserial, enum, postgis (point, polygon, geography, geometry), vector (pgvector), slug, email, url, ip, cidr, macaddr, interval, tsquery, tsvector, bytea, money, xml, array types | ✓ (TS schema builders complete, 139 tests passing) |

### Relations

| # | Task | Status |
|---|------|--------|
| 2 | Relation handling: belongsTo generates FK column + constraint, hasMany is virtual (no DB column), hasOne adds UNIQUE to FK, manyToMany generates junction table with composite PK | ✓ (TS schema builders complete) |

### Composites

| # | Task | Status |
|---|------|--------|
| 3 | Composite field expansion: timestamps adds created_at + updated_at with triggers, publishable adds status enum + published_at + scheduled_at, softDelete adds deleted_at with index | ✓ (TS schema builders complete) |

### Indexes

| # | Task | Status |
|---|------|--------|
| 4 | Index generation: btree (default), GIN (for jsonb/array/tsvector), GiST (for PostGIS), HNSW (for pgvector) | ✓ (TS schema builders complete; engine-side pending) |

### Constraints

| # | Task | Status |
|---|------|--------|
| 5 | Constraint generation: CHECK expressions, UNIQUE (single and composite), NOT NULL with default handling | ✓ (TS schema builders complete; engine-side pending) |

### Triggers

| # | Task | Status |
|---|------|--------|
| 6 | Trigger generation: updated_at auto-update trigger, slug generation from source field | ○ |

### Differ

| # | Task | Status |
|---|------|--------|
| 7 | Rename detection: Levenshtein similarity scoring between dropped and added columns/tables, interactive prompt for confirmation above threshold | ○ |
| 8 | Risk analysis: classify each diff operation as safe (additive), cautious (may fail on data), or destructive (data loss) | ○ |
| 9 | Topological sort of operations: dependency ordering so FKs are created after referenced tables | ○ |

### Migration

| # | Task | Status |
|---|------|--------|
| 10 | Rollback migration generation: generate reverse SQL for every forward operation | ○ |
| 11 | Migration history tracking: _definatype_migrations table with hash, timestamp, checksum, applied status | ○ |

### Performance

| # | Task | Status |
|---|------|--------|
| 12 | Schema state caching: store last-known DB state to avoid full introspection on every push | ○ |

### Testing

| # | Task | Status |
|---|------|--------|
| 13 | Comprehensive test suite: 10 base fixtures × 20+ evolution scenarios, Postgres 14/15/16 matrix | ○ |

## Technical Context

- The differ algorithm is the core intellectual property. It must handle: added/removed/modified tables, added/removed/modified columns, type changes (safe vs lossy), constraint changes, index changes, relation changes (FK lifecycle), RLS policy regeneration, and junction table management for manyToMany.
- Test fixtures: basic_blog, ecommerce, saas_multi_tenant, cms_content, geospatial, vector_search, self_referential, many_to_many, soft_delete, kitchen_sink.
- Evolution scenarios per fixture: add_column_nullable, add_column_not_null_with_default, add_column_not_null_no_default (should fail), drop_column, rename_column, change_column_type_safe, change_column_type_lossy, add_unique_constraint, add_not_null, add/drop FK, add/drop index, add/remove relations, change_access_rules, add_composite_publishable, multi_change_complex, destructive_drop_table.
- Performance benchmarks: 50-model schema < 500ms total push, 200-model schema < 2s total push.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Differ correctness for edge cases (rename vs drop+add, type coercion) | Exhaustive test fixtures; always err on side of asking user via interactive prompt |
| Junction table management complexity for manyToMany | Keep junction tables simple (composite PK, two FKs); support pivot fields in v2 |
| Scope creep — engine features could expand indefinitely | Freeze feature set at the 50+ test scenario level; defer to Phase 10 for advanced features |

## Success Criteria

Phase 1 is complete when:

- [ ] All 10 test fixtures pass fresh application (Phase 1 of test pipeline)
- [ ] All 20+ evolution scenarios pass per fixture (Phase 2 of test pipeline)
- [ ] Rollback migrations restore original state (Phase 3 of test pipeline)
- [ ] Idempotency verified — pushing same schema produces empty diff (Phase 4)
- [ ] Performance benchmarks met on CI for every commit
- [ ] Tests pass on Postgres 14, 15, and 16
