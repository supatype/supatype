# Session Log

---

## 2026-03-04 — Phase 1: full field type coverage & test fixtures

### Changes

#### 1. Added 16 missing field types to `@definatype/schema`
- **File:** `packages/schema/src/fields.ts`
- **New types:** `date` (DATE), `timestamp` (TIMESTAMP without TZ), `smallInt` (SMALLINT), `serial` (SERIAL, always required), `bigSerial` (BIGSERIAL), `url` (TEXT), `ip` (INET), `cidr` (CIDR), `macaddr` (MACADDR), `interval` (INTERVAL), `tsquery` (TSQUERY), `tsvector` (TSVECTOR), `bytea` (BYTEA), `money` (MONEY), `xml` (XML), `arrayOf` (element type + `[]`)
- **New type:** `ArrayFieldMeta` in `types.ts` for array field metadata

#### 2. Created 10 test fixtures
All fixtures in `packages/schema/tests/fixtures/`:
- `basic_blog` — Posts, users, categories, comments, tags (manyToMany)
- `ecommerce` — Products, variants, orders, order items, serial orderNumber
- `saas_multi_tenant` — Organisations, members, projects, tasks, labels, audit log (IP field)
- `cms_content` — Pages, blocks, media, folders, versions, nav menus (publishable composite)
- `geospatial` — Locations (point), regions (polygon), routes (linestring), geofences (interval field)
- `vector_search` — Documents, chunks (1536-dim embeddings), collections, search queries (tsvector + tsquery)
- `self_referential` — Categories, employees, nested comments, menu items (all self-referencing)
- `many_to_many` — Students-courses, clubs, articles-tags, course prerequisites (self-referencing M2M)
- `soft_delete` — Workspaces, folders, documents, API keys (arrayOf TEXT), notifications
- `kitchen_sink` — ALL scalar types, ALL relation types, ALL access patterns, ALL composites, ALL index types

#### 3. Test suite
- Added vitest (replacing Jest placeholder)
- 4 test files, 139 tests total:
  - `fields.test.ts` — 47 tests for every field type
  - `model.test.ts` — 9 tests for model builder
  - `serialiser.test.ts` — 13 tests for JSON AST serialisation
  - `fixtures.test.ts` — 70 tests (7 assertions x 10 fixtures)

### Status
- `pnpm --filter @definatype/schema test`: 139/139 passing
- `pnpm turbo run typecheck`: all packages clean
- Phase 1 tasks 1-5 (TS-side) marked complete in plan
- Tasks 6-13 are engine-side (separate repo)

---

## 2026-03-04 — Phase 0 integration tests: all passing

### Context
First `cargo test` run in the engine repo. Tests connected to a Postgres 11 container via testcontainers.

### Bugs fixed (in order encountered)

#### 1. `SETNULL` SQL syntax error
- **File:** `src/generator/sql/migration.rs`
- **Cause:** `rel.on_delete = "setNull"` → `.to_uppercase()` → `SETNULL` (one word). Postgres requires `SET NULL` (two words).
- **Fix:** Added `normalize_fk_action()` which maps camelCase/underscore variants (`setNull`, `set_null`, `noAction`, etc.) to proper SQL keywords.

#### 2. `gen_random_uuid() does not exist` (Postgres 11)
- **File:** `src/generator/sql/migration.rs`
- **Cause:** `gen_random_uuid()` is built into Postgres 13+, but the test container runs Postgres 11. PG 11 requires the `pgcrypto` extension.
- **Fix:** Added `needs_pgcrypto()` which scans the diff for `GenRandomUuid` defaults, and conditionally emits `CREATE EXTENSION IF NOT EXISTS "pgcrypto";` before `BEGIN` in the migration.

#### 3. `relation "public.category" does not exist` (FK ordering)
- **Files:** `src/generator/sql/migration.rs`, `src/differ/table_diff.rs`
- **Cause:** `create_table_sql` emitted FK `ALTER TABLE` statements inline via `post_stmts`, appended immediately after `CREATE TABLE posts`. These ran before `CREATE TABLE categories` in the same transaction.
- **Fix:**
  - Removed `post_stmts` FK generation from `create_table_sql`.
  - `table_diff` now emits separate `AddForeignKey` operations for each `belongsTo` relation on new tables. These sort to priority 6 (after all `CreateTable` ops at priority 2).

#### 4. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block
- **File:** `src/generator/sql/migration.rs`
- **Cause:** Index SQL used `CONCURRENTLY` but the entire migration runs inside `BEGIN`/`COMMIT`.
- **Fix:** Dropped `CONCURRENTLY` from both `CREATE INDEX` and `DROP INDEX`. Concurrent indexing is a Phase 1 concern.

#### 5. `relation "public.category"` again — wrong referenced table name
- **Files:** `src/differ/mod.rs`, `src/differ/table_diff.rs`, `src/generator/sql/migration.rs`
- **Cause:** `add_fk_sql` derived the referenced table via `to_snake_case(&rel.target)` — `"Category"` → `"category"`, but the actual table name was `"categories"` (from `tableName` in the fixture).
- **Fix:**
  - Added `ref_table: String` field to `Operation::AddForeignKey`.
  - `table_diff` resolves `ref_table` by looking up the target model in `ast.models` to get its `table_name`.
  - `add_fk_sql` now takes `ref_table: &str` as a parameter.

#### 6. Idempotency failure: second diff produced 15 ops instead of 0
Three separate root causes:

**6a. Phantom DropColumn for timestamp columns (8 ops)**
- **File:** `src/differ/column_diff.rs`
- **Cause:** Models with `options.timestamps = true` had `created_at`/`updated_at` added to the DB by `create_table_sql`, but `column_diff` didn't know about these — it only expanded explicit `FieldAst::Timestamps` fields. So the columns appeared as "extra" in the DB → `DropColumn` ops.
- **Fix:** Added `options_cols` HashSet in `column_diff::diff` that includes `created_at`/`updated_at` (and `deleted_at` for `soft_delete`) from model options. These are excluded from the `dropped` set.

**6b. Trigger stub comments never created real triggers (6 ops)**
- **File:** `src/differ/trigger_diff.rs`
- **Cause:** `CreateTrigger` SQL rendered as a `-- comment`, so triggers were never actually created in the DB. On every re-diff, `trigger_diff` would see the triggers as missing and generate new ops.
- **Fix:** Stubbed out `trigger_diff::diff` entirely for Phase 0. Trigger generation is deferred to Phase 1 (`definatype-engine generate --triggers`).

**6c. Index name mismatch (1 op)**
- **File:** `src/differ/index_diff.rs`
- **Cause:** `index_diff` used `index.name.as_deref().unwrap_or("unnamed")` for unnamed indexes. The SQL generator derived a name like `posts_author_id_idx`. So `index_diff` couldn't find the existing index by name.
- **Fix:** `index_diff` now derives the same default name as the SQL generator: `{table}_{fields}_idx`.

### Final test result
```
test result: ok. 2 passed; 0 failed  (integration_test.rs)
test result: ok. 1 passed; 0 failed  (differ_tests.rs)
test result: ok. 1 passed; 0 failed  (migration_tests.rs)
test result: ok. 2 passed; 0 failed  (parser_tests.rs)
```

### Phase 0 status update
- `cargo test` passes clean (6 tests, 0 failures, 0 warnings)
- Integration tests validated against real Postgres 11 via testcontainers
- Fresh schema application ✓
- Idempotency (second diff = 0 ops) ✓
- `pnpm turbo run typecheck` passes clean (from prior session)

**Remaining Phase 0 gaps:**
- Cross-compile binary artifacts not yet confirmed (CI/release workflow exists but hasn't run against a tag)
- Engine < 500ms criterion: not measured (likely met given 3s test time includes Docker container startup)
