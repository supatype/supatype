# [Platform] — Complete Architecture Specification

> Define your types. We generate your backend.

**Version:** 2.0
**Date:** March 2026
**Status:** Draft

---

## Table of Contents

1. Product Overview
2. The Schema Engine (Rust Binary — Closed Source)
3. The Type System (@[platform]/schema — Open Source)
4. Migration Pipeline — End to End
5. Infrastructure Architecture
6. Service Breakdown
7. Client SDK & React Hooks
8. Admin Panel (Auto-Generated)
9. Developer Dashboard (Studio)
10. CLI
11. Cloud Offering & Infrastructure
12. Self-Hosting
13. Security Model
14. Licensing & Distribution
15. Build Phases (Granular)
16. Open Questions & Decisions Log

---

## 1. Product Overview

### 1.1 The Problem

Frontend engineers building modern applications face a painful gap. They can build beautiful, performant UIs with React, Next.js, and TypeScript. But the moment they need a backend — a database, authentication, file storage, an API, an admin panel for their client — they hit a wall.

Current options force them to either:

- **Supabase / Firebase:** Learn database design, write SQL, manage migrations manually, build their own admin UI, wire up auth flows, handle file storage separately. The infrastructure works, but the developer experience assumes backend knowledge.
- **Payload / Strapi:** Get a great admin panel and content management, but lose the infrastructure layer. No built-in auth service, no realtime, no object storage, no auto-generated API from the data model. They're CMS-first, not backend-first.
- **Convex:** Good developer experience and type safety, but proprietary runtime, no Postgres, no self-hosting, no content management story.

None of these start from where the frontend engineer actually thinks: **data shapes.** Frontend developers think in TypeScript interfaces, component props, and API response types. They don't think in SQL tables, migration files, and RLS policies.

### 1.2 The Solution

A platform where the developer defines their data model using TypeScript, and everything else is generated automatically:

- Postgres database schema and migrations
- REST API endpoints (via PostgREST)
- TypeScript client SDK with full type safety
- Admin panel for non-technical users
- Authentication (via GoTrue fork)
- File storage with image transforms
- Realtime subscriptions
- Row-level security from access rules

The schema definition is the single source of truth. Change the schema, and the platform handles the migration, regenerates the API, updates the types, and refreshes the admin panel.

### 1.3 Target User

Primary: Frontend engineers (React, Next.js, Vue, Svelte) building full-stack applications who want type-safe backend infrastructure without learning database administration.

Secondary: Full-stack developers who want to move faster by eliminating boilerplate — migration files, API route handlers, admin panel development, auth integration.

Tertiary: Agencies and freelancers who need to ship client projects quickly with a content-manageable backend.

### 1.4 Core Principles

1. **Types are truth.** The TypeScript schema definition is canonical. The database is derived, never the reverse.
2. **Zero SQL required.** A developer should be able to build a complete application without writing a single line of SQL.
3. **Escape hatches everywhere.** When the developer needs raw SQL, custom API routes, or manual migrations, the platform doesn't fight them.
4. **Self-hostable by default.** The entire platform runs in Docker. Cloud is a convenience layer, not a requirement.
5. **Steal shamelessly.** Use battle-tested open-source components (PostgREST, GoTrue, Kong, MinIO) rather than reinventing them. Our value is in the schema engine and the integration, not in rebuilding auth or API servers.

---

## 2. The Schema Engine (Rust Binary — Closed Source)

### 2.1 Overview

The Schema Engine is the core intellectual property of the platform. It is a compiled Rust binary that:

1. Parses schema definitions (from JSON AST, not raw TypeScript)
2. Introspects the current Postgres database state
3. Computes a diff between desired and current state
4. Generates SQL migrations (forward and rollback)
5. Generates TypeScript type definitions
6. Generates PostgREST configuration
7. Generates RLS policy SQL
8. Generates admin panel configuration JSON

The engine is distributed as a precompiled binary for Linux (x86_64, aarch64), macOS (x86_64, aarch64), and Windows (x86_64). It is included in Docker images and downloaded automatically by the CLI.

### 2.2 Why Rust

- Single binary distribution with zero runtime dependencies
- Cross-compilation to all target platforms
- Future WASM compilation for running the engine in the browser (visual schema designer)
- Memory safety guarantees for a component handling production database migrations
- Performance headroom for enterprise schemas with hundreds of models

### 2.3 Binary Interface

The engine exposes a CLI interface. The TypeScript CLI wrapper and cloud platform call it as a subprocess. All input and output is JSON over stdin/stdout.

```
platform-engine <command> [flags]

Commands:
  parse       Parse schema AST and validate
  introspect  Read current database state
  diff        Compute schema diff
  migrate     Generate SQL migration from diff
  generate    Generate TypeScript types
  rls         Generate RLS policy SQL
  postgrest   Generate PostgREST configuration
  admin       Generate admin panel configuration
  validate    Validate a migration is safe to apply

Global Flags:
  --input   <path|->    Input file or stdin (default: stdin)
  --output  <path|->    Output file or stdout (default: stdout)
  --format  json|sql    Output format (default: json)
  --log     error|warn|info|debug   Log level (default: warn)
  --license <key>       License key (for gated enterprise features)
```

#### Command Details

**parse** — Validate and normalise a schema AST

```bash
# Input: Schema AST JSON (produced by @[platform]/schema TypeScript package)
# Output: Normalised and validated AST with resolved relations

cat schema-ast.json | platform-engine parse
```

Input:
```json
{
  "models": [
    {
      "name": "post",
      "tableName": "posts",
      "fields": {
        "title": {
          "kind": "text",
          "pgType": "TEXT",
          "constraints": {},
          "required": true,
          "unique": false
        },
        "author": {
          "kind": "relation",
          "cardinality": "belongsTo",
          "target": "user",
          "foreignKey": "author_id",
          "onDelete": "cascade"
        }
      },
      "access": {
        "read": { "type": "public" },
        "create": { "type": "role", "roles": ["admin", "editor"] }
      },
      "options": {
        "timestamps": true,
        "softDelete": false
      }
    }
  ]
}
```

Output:
```json
{
  "success": true,
  "ast": {
    "models": [...],
    "junctionTables": [...],
    "storageBuckets": [...],
    "resolvedRelations": [...],
    "warnings": []
  }
}
```

**introspect** — Read current database state

```bash
# Input: Database connection string
# Output: Current database state as JSON

echo '{"connectionString": "postgres://..."}' | platform-engine introspect
```

Output:
```json
{
  "success": true,
  "state": {
    "schemas": ["public", "auth", "storage"],
    "extensions": ["uuid-ossp", "postgis"],
    "tables": {
      "public.posts": {
        "columns": [
          { "name": "id", "type": "uuid", "nullable": false, "default": "gen_random_uuid()" },
          { "name": "title", "type": "text", "nullable": false, "default": null }
        ],
        "indexes": [...],
        "constraints": [...],
        "rlsPolicies": [...],
        "triggers": [...]
      }
    }
  }
}
```

**diff** — Compute the difference between target schema and current database

```bash
# Input: Target AST + current database state (or connection string)
# Output: Structured diff with risk analysis

echo '{"target": <ast>, "current": <state>}' | platform-engine diff
```

Output:
```json
{
  "success": true,
  "diff": {
    "operations": [
      {
        "type": "create_table",
        "table": "posts",
        "risk": "safe",
        "columns": [...]
      },
      {
        "type": "add_column",
        "table": "users",
        "column": { "name": "bio", "type": "TEXT", "nullable": true },
        "risk": "safe"
      },
      {
        "type": "alter_column",
        "table": "users",
        "column": "email",
        "changes": { "nullable": { "from": true, "to": false } },
        "risk": "destructive",
        "warning": "Setting NOT NULL on existing column 'email'. Rows with NULL values will cause the migration to fail."
      },
      {
        "type": "drop_column",
        "table": "posts",
        "column": "legacy_field",
        "risk": "destructive",
        "warning": "Dropping column 'legacy_field' from table 'posts'. This will permanently delete data."
      }
    ],
    "summary": {
      "safe": 5,
      "cautious": 1,
      "destructive": 2,
      "isDestructive": true,
      "requiresDataMigration": false
    },
    "warnings": [
      "2 destructive operations detected. Use --force to proceed or review individually."
    ]
  }
}
```

**migrate** — Generate SQL from a diff

```bash
echo '{"diff": <diff_output>}' | platform-engine migrate --format sql
```

Output:
```sql
-- Migration: 003_add_user_bio_alter_email
-- Generated: 2026-03-03T14:30:00Z
-- Risk: destructive (2 operations require review)
-- Platform Engine: v0.1.0

-- ============================================================
-- FORWARD MIGRATION
-- ============================================================

BEGIN;

-- [safe] Add column: users.bio
ALTER TABLE "public"."users"
  ADD COLUMN "bio" TEXT;

-- [destructive] Set NOT NULL: users.email
-- WARNING: Ensure no NULL values exist before applying
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."users" WHERE "email" IS NULL) THEN
    RAISE EXCEPTION 'Cannot set NOT NULL on users.email: NULL values exist. Run UPDATE users SET email = '''' WHERE email IS NULL; first.';
  END IF;
END $$;
ALTER TABLE "public"."users"
  ALTER COLUMN "email" SET NOT NULL;

-- [destructive] Drop column: posts.legacy_field
ALTER TABLE "public"."posts"
  DROP COLUMN IF EXISTS "legacy_field";

-- Record migration
INSERT INTO "_platform_migrations" (name, hash, applied_at)
VALUES ('003_add_user_bio_alter_email', 'sha256:abc123...', NOW());

COMMIT;

-- ============================================================
-- ROLLBACK MIGRATION
-- ============================================================
-- To apply: npx [platform] rollback

-- BEGIN;
-- ALTER TABLE "public"."users" DROP COLUMN IF EXISTS "bio";
-- ALTER TABLE "public"."users" ALTER COLUMN "email" DROP NOT NULL;
-- ALTER TABLE "public"."posts" ADD COLUMN "legacy_field" TEXT;
-- DELETE FROM "_platform_migrations" WHERE name = '003_add_user_bio_alter_email';
-- COMMIT;
```

**generate** — Generate TypeScript type definitions

```bash
echo '{"ast": <parsed_ast>}' | platform-engine generate
```

Output: complete TypeScript file content (see Section 7.1 for the full generated type format).

**rls** — Generate Row Level Security policies

```bash
echo '{"ast": <parsed_ast>}' | platform-engine rls
```

Output:
```sql
-- RLS Policies for: posts
-- Generated from schema access rules

ALTER TABLE "public"."posts" ENABLE ROW LEVEL SECURITY;

-- Read: public OR owner OR role(admin, editor)
CREATE POLICY "posts_select_policy" ON "public"."posts"
  FOR SELECT
  USING (
    (status = 'published')
    OR
    (auth.uid() = author_id)
    OR
    (auth.role() IN ('admin', 'editor'))
  );

-- Create: role(admin, editor, member)
CREATE POLICY "posts_insert_policy" ON "public"."posts"
  FOR INSERT
  WITH CHECK (
    auth.role() IN ('admin', 'editor', 'member')
  );

-- Update: owner(author_id) OR role(admin, editor)
CREATE POLICY "posts_update_policy" ON "public"."posts"
  FOR UPDATE
  USING (
    (auth.uid() = author_id)
    OR
    (auth.role() IN ('admin', 'editor'))
  );

-- Delete: role(admin)
CREATE POLICY "posts_delete_policy" ON "public"."posts"
  FOR DELETE
  USING (
    auth.role() = 'admin'
  );
```

### 2.4 Rust Engine Internal Architecture

```
platform-engine/
├── Cargo.toml
├── src/
│   ├── main.rs                    # CLI entry point (clap)
│   ├── lib.rs                     # Library root (for WASM reuse)
│   │
│   ├── parser/
│   │   ├── mod.rs
│   │   ├── ast.rs                 # AST type definitions
│   │   ├── validator.rs           # Schema validation rules
│   │   ├── resolver.rs            # Relation resolution, junction table inference
│   │   └── normaliser.rs          # Naming conventions, defaults
│   │
│   ├── introspector/
│   │   ├── mod.rs
│   │   ├── postgres.rs            # Postgres introspection queries
│   │   ├── tables.rs              # Table/column state extraction
│   │   ├── indexes.rs             # Index extraction
│   │   ├── constraints.rs         # FK, unique, check constraint extraction
│   │   ├── rls.rs                 # RLS policy extraction
│   │   ├── triggers.rs            # Trigger extraction
│   │   └── extensions.rs          # Extension detection
│   │
│   ├── differ/
│   │   ├── mod.rs
│   │   ├── table_diff.rs          # Table-level diffing
│   │   ├── column_diff.rs         # Column-level diffing (type changes, nullability, defaults)
│   │   ├── index_diff.rs          # Index diffing
│   │   ├── constraint_diff.rs     # Constraint diffing
│   │   ├── rls_diff.rs            # RLS policy diffing
│   │   ├── trigger_diff.rs        # Trigger diffing
│   │   ├── risk_analyser.rs       # Categorise operations by risk level
│   │   └── ordering.rs            # Topological sort of operations (FK dependencies)
│   │
│   ├── generator/
│   │   ├── mod.rs
│   │   ├── sql/
│   │   │   ├── migration.rs       # Forward migration SQL
│   │   │   ├── rollback.rs        # Rollback migration SQL
│   │   │   ├── rls.rs             # RLS policy SQL
│   │   │   └── triggers.rs        # Trigger SQL (slug generation, updated_at, etc.)
│   │   ├── typescript/
│   │   │   ├── types.rs           # Database type definitions
│   │   │   ├── client.rs          # Client SDK type augmentation
│   │   │   └── admin.rs           # Admin panel configuration JSON
│   │   └── config/
│   │       ├── postgrest.rs       # PostgREST configuration
│   │       └── kong.rs            # Kong route configuration
│   │
│   ├── state/
│   │   ├── mod.rs
│   │   ├── database_state.rs      # Representation of current DB state
│   │   ├── target_state.rs        # Representation of desired state
│   │   └── migration_history.rs   # Track applied migrations
│   │
│   └── licensing/
│       ├── mod.rs
│       └── features.rs            # Feature gating based on license key
│
├── tests/
│   ├── parser_tests.rs
│   ├── differ_tests.rs            # Critical: extensive diff test suite
│   ├── migration_tests.rs
│   ├── rls_tests.rs
│   └── fixtures/                  # Test schema definitions
│       ├── blog_schema.json
│       ├── ecommerce_schema.json
│       └── migration_scenarios/
│           ├── add_column.json
│           ├── drop_column.json
│           ├── rename_column.json
│           ├── change_type.json
│           ├── add_relation.json
│           ├── add_index.json
│           └── complex_multi_change.json
│
└── build.rs                       # Build script for version embedding
```

### 2.5 Key Rust Crates

```toml
[dependencies]
clap = { version = "4", features = ["derive"] }      # CLI argument parsing
serde = { version = "1", features = ["derive"] }      # JSON serialisation
serde_json = "1"                                       # JSON parsing
tokio = { version = "1", features = ["full"] }         # Async runtime
tokio-postgres = "0.7"                                 # Postgres driver
sqlx = { version = "0.8", features = ["postgres", "runtime-tokio"] }  # Alternative driver
thiserror = "2"                                        # Error types
tracing = "0.1"                                        # Logging
sha2 = "0.10"                                          # Migration hashing
petgraph = "0.7"                                       # Dependency graph for operation ordering
similar = "2"                                          # Text diffing (for migration previews)

[target.'cfg(target_arch = "wasm32")'.dependencies]
wasm-bindgen = "0.2"                                   # Future WASM support
```

### 2.6 Differ Algorithm — The Core Logic

The differ is the most complex and valuable part of the engine. It must handle every possible schema change safely.

```
Input:  TargetState (from parsed schema AST)
        CurrentState (from database introspection)
Output: OrderedOperationList (topologically sorted by dependencies)

Algorithm:

1. EXTENSIONS
   - Compare target extensions vs current extensions
   - Generate CREATE EXTENSION / DROP EXTENSION

2. ENUMS (if using Postgres enums)
   - New enums → CREATE TYPE
   - Removed enums → DROP TYPE (if no columns reference)
   - Modified enums → ALTER TYPE ADD VALUE (Postgres enums are append-only without tricks)

3. TABLES
   - Tables in target but not current → CREATE TABLE
   - Tables in current but not target → DROP TABLE (destructive, requires --force)
   - Tables in both → proceed to column diffing

4. COLUMNS (per table)
   For each table present in both target and current:
   a. New columns → ALTER TABLE ADD COLUMN
      - If NOT NULL and no default: WARN (will fail on non-empty table)
      - If NOT NULL with default: safe
      - If nullable: safe
   b. Removed columns → ALTER TABLE DROP COLUMN (destructive)
   c. Modified columns:
      - Type change: ALTER TABLE ALTER COLUMN TYPE (destructive, may need USING clause)
      - Nullability change:
        - NULL → NOT NULL: cautious (may fail if NULLs exist, add pre-check)
        - NOT NULL → NULL: safe
      - Default change: ALTER TABLE ALTER COLUMN SET/DROP DEFAULT (safe)
      - Unique added: CREATE UNIQUE INDEX (cautious, may fail if duplicates exist)
      - Unique removed: DROP INDEX (safe)
      - Check constraint change: DROP + ADD constraint

5. FOREIGN KEYS
   - New FK → ALTER TABLE ADD CONSTRAINT (safe if referenced data exists)
   - Removed FK → ALTER TABLE DROP CONSTRAINT (safe)
   - Modified FK (target changed, cascade changed) → DROP + ADD

6. INDEXES
   - New index → CREATE INDEX CONCURRENTLY (non-blocking)
   - Removed index → DROP INDEX CONCURRENTLY
   - Modified index → DROP + CREATE

7. JUNCTION TABLES (for manyToMany)
   - New junction → CREATE TABLE with composite PK and FKs
   - Removed junction → DROP TABLE (destructive)

8. RLS POLICIES
   - Diff policies by name
   - Changed → DROP POLICY + CREATE POLICY (always safe, doesn't affect data)

9. TRIGGERS
   - New triggers → CREATE TRIGGER
   - Removed triggers → DROP TRIGGER
   - Modified → DROP + CREATE

10. STORAGE BUCKETS
    - New buckets → insert into storage.buckets table
    - Bucket policy changes → update storage policies

11. OPERATION ORDERING
    Using petgraph, topologically sort all operations:
    - CREATE EXTENSION before tables that need them
    - CREATE TABLE before FKs that reference them
    - ADD COLUMN before indexes on those columns
    - DROP FK before DROP TABLE that it references
    - DROP INDEX before DROP COLUMN that it indexes

12. RISK ANALYSIS
    Each operation is tagged:
    - safe: no data loss possible
    - cautious: may fail but no data loss (e.g., adding NOT NULL)
    - destructive: permanent data loss possible (drops)

    Overall migration risk = max(operation risks)
```

#### Rename Detection

One of the hardest problems. If a column disappears and a new one appears with a similar name, is it a rename or a drop+add?

```
Strategy:
1. Exact name match → no change
2. Column gone + new column with same type and constraints → potential rename
3. Use string similarity (Levenshtein distance) on column names
4. If similarity > 0.7 and types match → suggest rename, ask for confirmation
5. If ambiguous → default to drop+add with warning

The CLI presents rename candidates interactively:
  "Column 'firstName' was removed and 'first_name' was added (same type TEXT).
   Is this a rename? [Y/n]"

In CI/CD (non-interactive), renames must be specified explicitly in a config file:
  // platform.renames.json
  { "users.firstName": "users.first_name" }
```

### 2.7 Testing Strategy — Round-Trip Correctness

The schema engine's generated SQL must be validated against real PostgreSQL instances, not just unit-tested in isolation. The test suite uses a round-trip correctness approach inspired by PostgreSQL's own pg_regress framework:

```
Test Pipeline (runs in CI against real Postgres 16 via testcontainers):

For each test fixture (blog, ecommerce, saas, cms, geospatial, etc.):

  Phase 1: Fresh schema application
  ─────────────────────────────────
  1. Start clean Postgres instance (testcontainers / pg_tmp)
  2. Feed schema AST to engine → parse → validate
  3. Introspect empty database → current state
  4. Compute diff (empty → target)
  5. Generate migration SQL
  6. Execute migration SQL against Postgres
  7. Introspect the resulting database
  8. ASSERT: introspected state matches target AST exactly
     - Every table exists with correct columns, types, constraints
     - Every index exists with correct configuration
     - Every FK exists with correct references and cascade rules
     - Every RLS policy exists with correct expressions
     - Every trigger exists and fires correctly

  Phase 2: Schema evolution (the critical test)
  ──────────────────────────────────────────────
  9. Seed database with realistic test data (100+ rows per table)
  10. Feed a modified schema AST (add columns, drop columns, change types,
      add relations, modify access rules, add indexes)
  11. Compute diff (current → new target)
  12. ASSERT: risk analysis is correct (safe/cautious/destructive tags)
  13. Generate diff migration SQL
  14. Execute migration SQL against Postgres (with seeded data present)
  15. ASSERT: migration succeeds without data loss (where safe/cautious)
  16. ASSERT: migration fails gracefully with clear error (where it should)
  17. Introspect the resulting database
  18. ASSERT: new state matches new target AST exactly

  Phase 3: Rollback verification
  ──────────────────────────────
  19. Execute rollback migration SQL
  20. Introspect the resulting database
  21. ASSERT: state matches original target (pre-evolution)
  22. ASSERT: seeded data is intact (for reversible operations)

  Phase 4: Idempotency
  ────────────────────
  23. Run push again with the same schema (no changes)
  24. ASSERT: diff is empty (no operations generated)
  25. ASSERT: no migration file created
```

**Test fixture coverage (minimum before v1):**

```
Fixtures:
  ├── basic_blog.json           # Posts, users, categories, comments
  ├── ecommerce.json            # Products, orders, variants, inventory
  ├── saas_multi_tenant.json    # Organisations, members, roles, billing
  ├── cms_content.json          # Pages, blocks, media, versions, publishing
  ├── geospatial.json           # Locations, regions, PostGIS types
  ├── vector_search.json        # Embeddings, pgvector, similarity search
  ├── self_referential.json     # Categories with parent_id, nested comments
  ├── many_to_many.json         # Tags, junction tables, pivot fields
  ├── soft_delete.json          # deleted_at patterns, filtered queries
  └── kitchen_sink.json         # All field types, all relation types, all access patterns

Evolution scenarios (per fixture):
  ├── add_column_nullable.json
  ├── add_column_not_null_with_default.json
  ├── add_column_not_null_no_default.json    # Should fail gracefully on non-empty table
  ├── drop_column.json
  ├── rename_column.json
  ├── change_column_type_safe.json           # e.g., VARCHAR → TEXT
  ├── change_column_type_lossy.json          # e.g., TEXT → INTEGER
  ├── add_unique_constraint.json             # Cautious: may fail if duplicates
  ├── add_not_null.json                      # Cautious: may fail if NULLs exist
  ├── add_foreign_key.json
  ├── drop_foreign_key.json
  ├── add_index.json
  ├── drop_index.json
  ├── add_relation_belongs_to.json
  ├── add_relation_many_to_many.json         # Creates junction table
  ├── remove_relation_many_to_many.json      # Drops junction table
  ├── change_access_rules.json               # RLS policy regeneration
  ├── add_composite_publishable.json         # Adds status + publishedAt + scheduledAt
  ├── multi_change_complex.json              # Multiple simultaneous changes
  └── destructive_drop_table.json            # Requires --force
```

**PostgreSQL version matrix:**

Tests run against Postgres 14, 15, and 16 in CI to ensure backward compatibility. PostGIS and pgvector extension versions are pinned to match the platform's Docker image.

**Performance benchmarks (tracked per commit):**

```
Benchmark: 50-model schema (ecommerce-scale)
  - Parse time: < 50ms
  - Introspect time: < 200ms
  - Diff time: < 100ms
  - Migration generation: < 50ms
  - Total push (no apply): < 500ms

Benchmark: 200-model schema (enterprise-scale)
  - Total push (no apply): < 2s
```

### 2.8 Distribution

The binary is distributed via:

1. **npm postinstall script** — `@[platform]/cli` downloads the correct binary for the current platform on install (same pattern as Prisma, esbuild, SWC)
2. **Docker images** — pre-included in all platform Docker images
3. **Direct download** — from platform website/GitHub releases (for manual installation)
4. **Homebrew / apt / yum** — for system-level installation

```typescript
// packages/cli/scripts/postinstall.ts
// Downloads the correct binary for the current platform

const PLATFORM_MAP = {
  'darwin-x64': 'platform-engine-macos-x64',
  'darwin-arm64': 'platform-engine-macos-arm64',
  'linux-x64': 'platform-engine-linux-x64',
  'linux-arm64': 'platform-engine-linux-arm64',
  'win32-x64': 'platform-engine-windows-x64.exe',
}

const key = `${process.platform}-${process.arch}`
const binary = PLATFORM_MAP[key]
// Download from CDN, verify checksum, make executable
```

### 2.8 Feature Gating

The binary is free to use with no model limits (matching Supabase's approach of gating on infrastructure, not schema complexity). Enterprise features within the binary are gated behind a license key:

```
Community (no license key):
  - All parse, diff, migrate, generate commands
  - Unlimited models
  - Standard diff algorithm
  - Full self-host support

Pro (license key tier 1):
  - Migration safety analysis (pre-flight checks against production data)
  - Advanced rename detection with ML-assisted confidence scoring
  - Migration dry-run with row count impact estimates

Enterprise (license key tier 2):
  - Everything in Pro
  - Multi-database support (generate migrations for multiple environments)
  - Custom migration hooks (pre/post migration scripts)
  - Audit trail of all schema changes (who changed what, when)
  - Priority diffing for large schemas (parallel processing)
  - Migration approval workflows (require sign-off before apply)
```

---

## 3. The Type System (@[platform]/schema — Open Source)

### 3.1 Package Structure

```
packages/schema/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Public API exports
│   ├── model.ts              # model() function
│   ├── fields.ts             # field.text(), field.email(), etc.
│   ├── relations.ts          # relation.belongsTo(), etc.
│   ├── access.ts             # access.public(), access.role(), etc.
│   ├── types.ts              # Core type definitions
│   ├── composites.ts         # field.timestamps(), field.publishable()
│   ├── validators.ts         # Runtime validation of field options
│   └── serialiser.ts         # Converts runtime objects → JSON AST for engine
├── tests/
│   ├── fields.test.ts
│   ├── model.test.ts
│   ├── relations.test.ts
│   ├── serialiser.test.ts
│   └── type-inference.test.ts  # Compile-time type tests
└── README.md
```

### 3.2 How TypeScript Type Inference Works

The key trick is using **conditional types and generics** so that the runtime metadata objects also carry TypeScript type information. The developer never writes type annotations — they come for free from the builder functions.

```typescript
// The developer writes this:
const Post = model('post', {
  fields: {
    title: field.text({ required: true }),
    excerpt: field.text(),
    status: field.enum(['draft', 'published'] as const),
  }
})

// TypeScript infers:
// Post.fields.title.__output → string (required, never null)
// Post.fields.excerpt.__output → string | null (optional)
// Post.fields.status.__output → 'draft' | 'published' | null

// The generated types use these inferences:
type PostRow = {
  title: string
  excerpt: string | null
  status: 'draft' | 'published' | null
}

type PostInsert = {
  title: string        // required — no ?
  excerpt?: string     // optional
  status?: 'draft' | 'published'
}
```

The `as const` on enum values is important — it preserves the literal union type rather than widening to `string`. The docs and error messages should make this clear.

### 3.3 The Serialiser — Bridge to the Rust Engine

The TypeScript CLI needs to convert the runtime model objects into JSON that the Rust engine can parse:

```typescript
// packages/schema/src/serialiser.ts

import type { ModelDefinition } from './types'

export function serialiseSchema(models: Record<string, ModelDefinition<any>>): SchemaAST {
  return {
    models: Object.entries(models).map(([exportName, model]) => ({
      name: model.__modelMeta.name,
      tableName: model.__modelMeta.tableName,
      fields: serialiseFields(model.__modelMeta.fields),
      access: serialiseAccess(model.__modelMeta.access),
      hooks: model.__modelMeta.hooks ?? {},
      indexes: model.__modelMeta.indexes ?? [],
      options: model.__modelMeta.options,
    })),
  }
}

function serialiseFields(fields: Record<string, any>): Record<string, FieldAST> {
  const result: Record<string, FieldAST> = {}

  for (const [name, def] of Object.entries(fields)) {
    if (def.__fieldMeta) {
      result[name] = {
        kind: def.__fieldMeta.kind,
        pgType: def.__fieldMeta.pgType,
        constraints: def.__fieldMeta.constraints,
        required: def.__fieldMeta.required,
        default: def.__fieldMeta.default,
        unique: def.__fieldMeta.unique ?? false,
        index: def.__fieldMeta.index ?? false,
      }
    } else if (def.__relationMeta) {
      result[name] = {
        kind: 'relation',
        cardinality: def.__relationMeta.cardinality,
        target: def.__relationMeta.target,
        foreignKey: def.__relationMeta.foreignKey,
        through: def.__relationMeta.through,
        onDelete: def.__relationMeta.onDelete,
        onUpdate: def.__relationMeta.onUpdate,
      }
    }
  }

  return result
}

// The CLI calls this and pipes the output to the Rust engine:
// const ast = serialiseSchema({ User, Post, Category, Comment })
// const json = JSON.stringify(ast)
// execSync(`echo '${json}' | platform-engine parse`)
```

### 3.4 Complete Field Type Reference

```typescript
// Every field type, its options, and what it generates

field.text(opts?)
  // Options: required, maxLength, default, unique, index
  // Postgres: TEXT or VARCHAR(n)
  // TypeScript: string

field.richText(opts?)
  // Options: required
  // Postgres: JSONB (Lexical/ProseMirror JSON format)
  // TypeScript: RichTextContent (JSON structure)
  // Admin panel: full rich text editor

field.integer(opts?)
  // Options: required, min, max, default
  // Postgres: INTEGER + CHECK constraints for min/max
  // TypeScript: number

field.float(opts?)
  // Options: required, default
  // Postgres: DOUBLE PRECISION
  // TypeScript: number

field.boolean(opts?)
  // Options: required, default
  // Postgres: BOOLEAN
  // TypeScript: boolean

field.datetime(opts?)
  // Options: required, default ('now'), index
  // Postgres: TIMESTAMPTZ
  // TypeScript: string (ISO 8601 from API) or Date (in client helpers)

field.email(opts?)
  // Options: required, unique
  // Postgres: TEXT + CHECK (format validation)
  // TypeScript: string

field.slug(opts)
  // Options: from (required — source field), unique, required
  // Postgres: TEXT + TRIGGER (auto-generates from source on insert)
  // TypeScript: string
  // Auto-generates: kebab-case slug, handles duplicates with suffix

field.enum(values, opts?)
  // Options: required, default
  // Postgres: TEXT + CHECK (value IN (...))
  // TypeScript: literal union type (requires `as const` on values array)
  // Note: We use TEXT + CHECK rather than Postgres ENUM type because:
  //   - ENUM type alterations are painful (can't remove values easily)
  //   - CHECK constraints are simpler to modify in migrations
  //   - No practical performance difference for typical enum sizes

field.json<TShape>(opts?)
  // Options: required, schema (Zod schema for runtime validation)
  // Postgres: JSONB
  // TypeScript: TShape (generic) or Record<string, unknown>

field.image(opts?)
  // Options: required, maxSize, allowedFormats, transforms
  // Postgres: JSONB (stores storage reference metadata)
  // TypeScript: StorageReference
  // Side effect: creates/configures a storage bucket
  // Admin panel: image upload with preview and transform controls

field.file(opts?)
  // Options: required, maxSize, allowedMimeTypes
  // Postgres: JSONB (stores storage reference metadata)
  // TypeScript: StorageReference

field.geo(opts?)
  // Options: required, type (point/polygon/linestring), srid
  // Postgres: GEOGRAPHY(...) via PostGIS
  // TypeScript: GeoJSON
  // Requires: PostGIS extension (auto-enabled)

field.vector(opts)
  // Options: dimensions (required), required
  // Postgres: VECTOR(n) via pgvector
  // TypeScript: number[]
  // Requires: pgvector extension (auto-enabled)

// ──── Composite Fields (expand to multiple columns) ────

field.publishable()
  // Expands to:
  //   status: TEXT (draft|published|scheduled|archived), default 'draft'
  //   publishedAt: TIMESTAMPTZ, nullable
  //   scheduledAt: TIMESTAMPTZ, nullable, indexed
  // Admin panel: publish/schedule workflow UI

field.timestamps()
  // Expands to:
  //   createdAt: TIMESTAMPTZ, NOT NULL, default NOW()
  //   updatedAt: TIMESTAMPTZ, NOT NULL, default NOW() + auto-update trigger

// ──── Relations ────

relation.belongsTo(target, opts?)
  // Options: foreignKey, required, onDelete, onUpdate
  // Creates: FK column on current table (default: {target}_id UUID)
  // TypeScript: related model's Row type

relation.hasMany(target, opts?)
  // Options: foreignKey
  // Creates: nothing on current table (FK lives on target)
  // TypeScript: array of related model's Row type

relation.hasOne(target, opts?)
  // Options: foreignKey
  // Creates: nothing on current table (FK lives on target)
  // TypeScript: related model's Row type | null

relation.manyToMany(target, opts?)
  // Options: through (junction table name), pivotFields
  // Creates: junction table with composite PK
  // TypeScript: array of related model's Row type
```

---

## 4. Migration Pipeline — End to End

### 4.1 Developer Workflow

```
Developer edits schema/index.ts
           │
           ▼
┌─────────────────────┐
│  npx [platform] push │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  CLI: Load schema files via tsx/ts-node      │
│  CLI: Serialise models → JSON AST            │
└──────────┬──────────────────────────────────┘
           │ JSON AST via stdin
           ▼
┌─────────────────────────────────────────────┐
│  Rust Engine: parse                          │
│  - Validate all models                       │
│  - Resolve relations (check targets exist)   │
│  - Infer junction tables                     │
│  - Detect storage bucket requirements        │
│  Output: validated + normalised AST          │
└──────────┬──────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  Rust Engine: introspect                     │
│  - Connect to Postgres                       │
│  - Read information_schema                   │
│  - Read pg_catalog for indexes, constraints  │
│  - Read RLS policies                         │
│  - Read triggers and functions               │
│  Output: current database state              │
└──────────┬──────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  Rust Engine: diff                           │
│  - Compare target AST vs current state       │
│  - Detect renames (interactive prompt)       │
│  - Categorise operations by risk             │
│  - Topologically sort operations             │
│  Output: structured diff + risk analysis     │
└──────────┬──────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  CLI: Display diff to developer              │
│                                              │
│  ✓ 3 safe operations                         │
│  ⚠ 1 cautious operation                      │
│  ✗ 1 destructive operation                   │
│                                              │
│  + Add column: posts.featured (BOOLEAN)      │
│  + Add column: posts.reading_time (INTEGER)  │
│  + Add index: idx_posts_featured             │
│  ~ Set NOT NULL: users.email (cautious)      │
│  - Drop column: posts.legacy (destructive)   │
│                                              │
│  Apply migration? [y/N/preview]              │
└──────────┬──────────────────────────────────┘
           │ Developer confirms
           ▼
┌─────────────────────────────────────────────┐
│  Rust Engine: migrate                        │
│  - Generate forward SQL                      │
│  - Generate rollback SQL                     │
│  - Generate migration hash                   │
│  Output: SQL files                           │
└──────────┬──────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  CLI: Apply migration                        │
│  - Execute SQL against database              │
│  - Record in _platform_migrations table      │
│  - Save migration file to migrations/ dir    │
└──────────┬──────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  Rust Engine: generate                       │
│  - Generate TypeScript types                 │
│  Output: .platform/types/database.gen.ts     │
└──────────┬──────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  Rust Engine: rls                            │
│  - Generate RLS policy SQL from access rules │
│  CLI: Apply RLS SQL to database              │
└──────────┬──────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  Rust Engine: postgrest                      │
│  - Generate PostgREST config                 │
│  CLI: Reload PostgREST (NOTIFY pgrst)       │
└──────────┬──────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  Rust Engine: admin                          │
│  - Generate admin panel config JSON          │
│  CLI: Write to .platform/admin-config.json   │
│  CLI: Hot-reload admin panel (dev mode)      │
└──────────┬──────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  Done.                                       │
│                                              │
│  ✓ Migration 003_add_post_fields applied     │
│  ✓ TypeScript types regenerated              │
│  ✓ RLS policies updated                      │
│  ✓ API endpoints reloaded                    │
│  ✓ Admin panel updated                       │
│                                              │
│  API: http://localhost:8000/rest/v1           │
│  Studio: http://localhost:3000                │
│  Admin: http://localhost:3001                 │
└─────────────────────────────────────────────┘
```

### 4.2 Migration File Storage

```
project/
├── schema/
│   └── index.ts
├── migrations/
│   ├── 001_initial_schema.sql
│   ├── 001_initial_schema.rollback.sql
│   ├── 002_add_categories.sql
│   ├── 002_add_categories.rollback.sql
│   ├── 003_add_post_fields.sql
│   └── 003_add_post_fields.rollback.sql
├── .platform/
│   ├── schema-state.json          # Last known schema state (for offline diffing)
│   ├── types/
│   │   └── database.gen.ts        # Generated TypeScript types
│   ├── admin-config.json          # Generated admin panel configuration
│   └── engine/
│       └── platform-engine        # Downloaded Rust binary
└── platform.config.ts             # Project configuration
```

### 4.3 The Migrations Table

```sql
CREATE TABLE IF NOT EXISTS "_platform_migrations" (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  hash        TEXT NOT NULL,              -- SHA-256 of migration SQL
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rolled_back BOOLEAN NOT NULL DEFAULT FALSE,
  rolled_back_at TIMESTAMPTZ,
  engine_version TEXT NOT NULL,           -- Engine version that generated it
  schema_snapshot JSONB                   -- Full schema AST at time of migration
);
```

### 4.4 CI/CD Integration

In CI, the migration must run non-interactively:

```yaml
# GitHub Actions example
- name: Apply migrations
  run: |
    npx [platform] push \
      --non-interactive \
      --allow-destructive \          # or explicitly list accepted destructive ops
      --renames platform.renames.json \
      --db ${{ secrets.DATABASE_URL }}
```

The `--non-interactive` flag:
- Skips confirmation prompts
- Fails on ambiguous renames (must be specified in config)
- Fails on destructive operations unless `--allow-destructive` is set
- Outputs structured JSON for CI parsing

---

## 5. Infrastructure Architecture

### 5.1 Service Map

```
┌──────────────────────────────────────────────────────────────────────┐
│                           Ingress / Load Balancer                    │
│                     (Traefik in self-host, ALB in cloud)             │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                ┌────────────▼────────────┐
                │       Kong Gateway       │
                │                          │
                │  /rest/v1/*  → PostgREST │
                │  /graphql/v1 → pg_graphql│
                │  /auth/v1/*  → GoTrue    │
                │  /storage/v1/* → Storage │
                │  /realtime/* → Realtime  │
                │  /admin/*   → Admin App  │
                │  /studio/*  → Studio App │
                │                          │
                │  JWT validation           │
                │  Rate limiting            │
                │  CORS                     │
                │  Request logging          │
                └──┬───┬───┬───┬───┬───┬──┘
                   │   │   │   │   │   │
        ┌──────────┘   │   │   │   │   └──────────┐
        │              │   │   │   │               │
  ┌─────▼─────┐ ┌──────▼─┐│┌──▼───▼──┐   ┌───────▼───────┐
  │ PostgREST │ │GoTrue  │││Realtime  │   │  Storage API  │
  │           │ │        │││Server    │   │               │
  │ Port 3000 │ │Port 9999│││Port 4000│   │  Port 5000    │
  └─────┬─────┘ └───┬────┘│└────┬────┘   └───────┬───────┘
        │            │     │     │                 │
        │            │     │     │           ┌─────▼─────┐
        │            │     │     │           │   MinIO    │
        │            │     │     │           │  (or S3)   │
        │            │     │     │           │            │
        │            │     │     │           │  Port 9000 │
        │            │     │     │           └────────────┘
        │            │     │     │
  ┌─────▼────────────▼─────▼─────▼────────────────────────┐
  │                     PostgreSQL 16                       │
  │                                                        │
  │  Schemas:                                              │
  │  ┌──────────────────────────────────────────────────┐  │
  │  │ public    — Application tables (from schema)     │  │
  │  │ auth      — GoTrue tables (users, sessions, etc) │  │
  │  │ storage   — Bucket and object metadata           │  │
  │  │ _platform — Migration history, config            │  │
  │  └──────────────────────────────────────────────────┘  │
  │                                                        │
  │  Extensions:                                           │
  │  uuid-ossp, pgcrypto, pgjwt, postgis, pgvector,       │
  │  pg_cron, pg_net, pg_stat_statements, pg_graphql       │
  │                                                        │
  │  Port 5432                                             │
  └────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────┐
  │                Dashboard Applications                   │
  │                                                        │
  │  ┌─────────────┐  ┌──────────────────────────────────┐ │
  │  │   Studio    │  │      Admin Panel                 │ │
  │  │  (Dev UI)   │  │    (Content Management)          │ │
  │  │             │  │                                  │ │
  │  │  Port 3100  │  │  Port 3200                       │ │
  │  └─────────────┘  └──────────────────────────────────┘ │
  └────────────────────────────────────────────────────────┘
```

### 5.2 PostgreSQL Schema Layout

```sql
-- ================================================================
-- Schema: _platform (internal metadata)
-- ================================================================

CREATE SCHEMA IF NOT EXISTS _platform;

-- Migration tracking
CREATE TABLE _platform.migrations (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  hash            TEXT NOT NULL,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rolled_back     BOOLEAN NOT NULL DEFAULT FALSE,
  engine_version  TEXT NOT NULL,
  schema_snapshot JSONB
);

-- Schema state cache (for quick introspection)
CREATE TABLE _platform.schema_state (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  state       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Webhook registrations (from schema hooks)
CREATE TABLE _platform.webhooks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model       TEXT NOT NULL,
  event       TEXT NOT NULL,      -- 'afterCreate', 'afterUpdate', 'onPublish', etc.
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ================================================================
-- Schema: auth (GoTrue managed)
-- ================================================================

-- GoTrue creates and manages its own tables:
-- auth.users, auth.sessions, auth.refresh_tokens,
-- auth.mfa_factors, auth.identities, etc.

-- We add platform-specific extensions:
-- auth.user_roles — maps users to roles defined in schema
CREATE TABLE auth.user_roles (
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by  UUID REFERENCES auth.users(id),
  PRIMARY KEY (user_id, role)
);

-- Helper functions used by RLS policies
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
  SELECT auth.jwt() ->> 'sub'
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
  SELECT auth.jwt() ->> 'role'
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION auth.roles() RETURNS TEXT[] AS $$
  SELECT ARRAY(
    SELECT role FROM auth.user_roles
    WHERE user_id = auth.uid()
  )
$$ LANGUAGE SQL STABLE;

-- ================================================================
-- Schema: storage (object storage metadata)
-- ================================================================

CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE storage.buckets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  public      BOOLEAN NOT NULL DEFAULT FALSE,
  file_size_limit BIGINT,
  allowed_mime_types TEXT[],
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE storage.objects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id   TEXT NOT NULL REFERENCES storage.buckets(id),
  name        TEXT NOT NULL,             -- full path within bucket
  owner       UUID REFERENCES auth.users(id),
  mime_type   TEXT,
  size        BIGINT,
  metadata    JSONB,                     -- dimensions, transforms, etc.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bucket_id, name)
);

-- RLS on storage
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- ================================================================
-- Schema: public (application tables — generated by schema engine)
-- ================================================================

-- Example output for the blog schema:

CREATE TABLE public.users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE CHECK (email ~* '^[^@]+@[^@]+\.[^@]+$'),
  name        TEXT NOT NULL,
  avatar      JSONB,                     -- storage reference
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'editor', 'member')),
  bio         TEXT CHECK (char_length(bio) <= 500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ                -- soft delete
);

CREATE TABLE public.posts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  content     JSONB NOT NULL,
  excerpt     TEXT CHECK (char_length(excerpt) <= 280),
  cover_image JSONB,
  author_id   UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tags        JSONB,
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'published', 'scheduled', 'archived')),
  published_at TIMESTAMPTZ,
  scheduled_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT,
  parent_id   UUID REFERENCES public.categories(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Junction table (auto-generated from manyToMany relation)
CREATE TABLE public.post_categories (
  post_id     UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, category_id)
);

-- Indexes
CREATE INDEX idx_posts_author_id ON public.posts(author_id);
CREATE INDEX idx_posts_status_published_at ON public.posts(status, published_at);
CREATE INDEX idx_posts_content_gin ON public.posts USING GIN (content);
CREATE INDEX idx_categories_parent_id ON public.categories(parent_id);

-- Auto-update trigger for updated_at
CREATE OR REPLACE FUNCTION _platform.update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_timestamp
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION _platform.update_timestamp();

CREATE TRIGGER update_posts_timestamp
  BEFORE UPDATE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION _platform.update_timestamp();

-- Slug generation trigger
CREATE OR REPLACE FUNCTION _platform.generate_slug()
RETURNS TRIGGER AS $$
DECLARE
  base_slug TEXT;
  final_slug TEXT;
  counter INTEGER := 0;
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    base_slug := regexp_replace(lower(trim(NEW.title)), '[^a-z0-9]+', '-', 'g');
    base_slug := regexp_replace(base_slug, '^-|-$', '', 'g');
    final_slug := base_slug;

    LOOP
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM public.posts WHERE slug = final_slug AND id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      );
      counter := counter + 1;
      final_slug := base_slug || '-' || counter;
    END LOOP;

    NEW.slug := final_slug;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER generate_posts_slug
  BEFORE INSERT OR UPDATE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION _platform.generate_slug();
```

### 5.3 PostgREST Configuration

Generated by the Rust engine from the schema AST:

```
# postgrest.conf — auto-generated

db-uri = "postgres://authenticator:password@postgres:5432/platform"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "${JWT_SECRET}"
jwt-aud = "authenticated"

# Roles:
# anon            — unauthenticated requests
# authenticated   — any logged-in user
# service_role    — bypasses RLS (for admin operations)

# PostgREST auto-generates endpoints for all tables in the public schema
# Filtering, sorting, pagination, and nested resource embedding all work
# out of the box via PostgREST's query syntax:
#
# GET /rest/v1/posts?status=eq.published&order=published_at.desc&limit=10
# GET /rest/v1/posts?select=title,slug,author:users(name)
# POST /rest/v1/posts  (with JSON body)
# PATCH /rest/v1/posts?id=eq.xxx
# DELETE /rest/v1/posts?id=eq.xxx
```

### 5.4 pg_graphql Configuration

pg_graphql is a Postgres extension that provides a GraphQL API directly from the database schema. Since it runs inside Postgres itself, it automatically reflects any schema changes — no separate GraphQL server needed.

```sql
-- Enable the extension
CREATE EXTENSION IF NOT EXISTS pg_graphql;

-- pg_graphql exposes a function that PostgREST can call:
-- POST /graphql/v1 routes through PostgREST to the graphql.resolve() function
-- This means GraphQL inherits the same JWT auth and RLS policies as REST

-- Example GraphQL query (sent as POST to /graphql/v1):
-- {
--   postCollection(filter: { status: { eq: "published" } }, orderBy: [{ publishedAt: DescNullsLast }], first: 10) {
--     edges {
--       node {
--         id
--         title
--         slug
--         author {
--           name
--         }
--         categoryCollection {
--           edges {
--             node {
--               name
--             }
--           }
--         }
--       }
--     }
--   }
-- }
```

Key benefits of pg_graphql over a separate GraphQL server:
- Zero maintenance: runs inside Postgres, auto-reflects schema changes
- Same auth: inherits PostgREST's JWT validation and Postgres RLS
- Same connection: no additional network hop, queries run in-process
- Filtering, ordering, pagination, and relation traversal work automatically

The client SDK will include a `.graphql()` method alongside the REST query builder, giving developers the choice of either query style with the same auth and type safety.

### 5.5 Kong Configuration

```yaml
# kong.yml — auto-generated

_format_version: "3.0"

services:
  # PostgREST API (REST + GraphQL)
  - name: rest-api
    url: http://postgrest:3000
    routes:
      - name: rest-routes
        paths:
          - /rest/v1
        strip_path: true
      - name: graphql-routes
        paths:
          - /graphql/v1
        strip_path: true
    plugins:
      - name: jwt
        config:
          claims_to_verify:
            - exp
      - name: rate-limiting
        config:
          minute: 1000
          policy: local
      - name: cors
        config:
          origins:
            - "*"
          methods:
            - GET
            - POST
            - PATCH
            - DELETE
            - OPTIONS
          headers:
            - Authorization
            - Content-Type
            - apikey
            - Prefer
          credentials: true

  # GoTrue Auth
  - name: auth-api
    url: http://gotrue:9999
    routes:
      - name: auth-routes
        paths:
          - /auth/v1
        strip_path: true
    plugins:
      - name: rate-limiting
        config:
          minute: 100            # stricter for auth endpoints
          policy: local
      - name: cors

  # Storage API
  - name: storage-api
    url: http://storage:5000
    routes:
      - name: storage-routes
        paths:
          - /storage/v1
        strip_path: true
    plugins:
      - name: jwt
      - name: rate-limiting
      - name: cors

  # Realtime
  - name: realtime-api
    url: http://realtime:4000
    routes:
      - name: realtime-routes
        paths:
          - /realtime/v1
        strip_path: true
    plugins:
      - name: jwt

  # Studio (developer dashboard)
  - name: studio
    url: http://studio:3100
    routes:
      - name: studio-routes
        paths:
          - /studio

  # Admin Panel
  - name: admin
    url: http://admin:3200
    routes:
      - name: admin-routes
        paths:
          - /admin

consumers:
  # Anonymous consumer (for public API access)
  - username: anon
    keyauth_credentials:
      - key: ${ANON_KEY}

  # Service role consumer (for admin/server-side access)
  - username: service_role
    keyauth_credentials:
      - key: ${SERVICE_ROLE_KEY}
```

---

## 6. Service Breakdown

### 6.1 GoTrue (Auth Service)

**Source:** Fork of github.com/supabase/auth (Go)

**Modifications from upstream:**

1. **Role integration with schema engine.** When a schema defines roles via `field.enum()` and `access.role()`, the auth service needs to know about valid roles. We add an endpoint that the schema engine calls after push to update the valid role list.

2. **Default role assignment.** When a user signs up, they're assigned the default role from the schema (e.g., 'member'). The schema engine generates a Postgres trigger:

```sql
CREATE OR REPLACE FUNCTION auth.assign_default_role()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO auth.user_roles (user_id, role)
  VALUES (NEW.id, 'member');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assign_role_on_signup
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION auth.assign_default_role();
```

3. **JWT claims enrichment.** The JWT includes the user's roles:

```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "role": "authenticated",
  "app_roles": ["member"],
  "aud": "authenticated",
  "exp": 1709500000
}
```

**Configuration:**

```env
# gotrue.env
GOTRUE_DB_DRIVER=postgres
GOTRUE_DB_DATABASE_URL=postgres://gotrue:password@postgres:5432/platform
GOTRUE_SITE_URL=http://localhost:3000
GOTRUE_JWT_SECRET=${JWT_SECRET}
GOTRUE_JWT_EXP=3600
GOTRUE_JWT_AUD=authenticated
GOTRUE_EXTERNAL_GOOGLE_ENABLED=true
GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOTRUE_EXTERNAL_GOOGLE_SECRET=${GOOGLE_SECRET}
GOTRUE_EXTERNAL_GITHUB_ENABLED=true
GOTRUE_MAILER_AUTOCONFIRM=false
GOTRUE_SMTP_HOST=${SMTP_HOST}
GOTRUE_SMTP_PORT=${SMTP_PORT}
GOTRUE_SMTP_USER=${SMTP_USER}
GOTRUE_SMTP_PASS=${SMTP_PASS}
```

### 6.2 Storage Service

**Technology:** Custom Node.js/TypeScript service (similar to Supabase's storage-api)

**Responsibilities:**
- Upload/download files to S3-compatible storage
- Image transformation on the fly (via sharp)
- Access control (respecting RLS policies on storage.objects table)
- Bucket management (auto-created from schema)
- Pre-signed URL generation for direct uploads

**API Endpoints:**

```
POST   /storage/v1/object/:bucket/:path     Upload file
GET    /storage/v1/object/:bucket/:path      Download file
GET    /storage/v1/object/public/:bucket/:path  Public download (no auth)
DELETE /storage/v1/object/:bucket/:path      Delete file
POST   /storage/v1/object/list/:bucket       List objects in bucket
POST   /storage/v1/object/move               Move/rename object
POST   /storage/v1/object/copy               Copy object
POST   /storage/v1/object/sign/:bucket/:path Pre-signed URL
```

**Image Transforms (query params on GET):**

```
GET /storage/v1/render/image/public/posts/cover.jpg?width=800&height=400&resize=cover&format=webp&quality=80
```

Supported transforms:
- `width` / `height` — resize dimensions
- `resize` — `cover`, `contain`, `fill`, `inside`, `outside`
- `format` — `webp`, `avif`, `jpeg`, `png`
- `quality` — 1-100

**Auto-bucket creation from schema:**

When the schema engine encounters `field.image()` or `field.file()`, it generates a storage bucket creation command:

```sql
-- From schema: Post model has coverImage: field.image()
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'post-cover-images',
  'Post Cover Images',
  true,                                    -- public read (based on access rules)
  5242880,                                 -- 5MB default
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml']
)
ON CONFLICT (id) DO UPDATE SET
  allowed_mime_types = EXCLUDED.allowed_mime_types;
```

### 6.3 Realtime Service

**Technology:** Node.js with ws (WebSocket library)

Node.js was chosen over Elixir/Phoenix for v1 to keep the stack consistent (Node.js for realtime, storage, and tooling). If scale demands it, Elixir can be evaluated later — but Node.js handles thousands of concurrent WebSocket connections comfortably, which is sufficient through the Team tier.

**How it works:**

1. Client opens WebSocket connection with JWT
2. Client subscribes to channels (table changes, custom broadcasts)
3. Server listens to Postgres logical replication (using pg_logical / wal2json)
4. When a change occurs, server checks if the user's JWT grants access via RLS
5. If authorised, server pushes the change to the client

**Protocol:**

```typescript
// Client → Server (subscribe)
{
  "type": "subscribe",
  "channel": "public:posts",
  "event": "INSERT",
  "filter": { "status": "eq.published" }
}

// Server → Client (change event)
{
  "type": "change",
  "channel": "public:posts",
  "event": "INSERT",
  "payload": {
    "old": null,
    "new": { "id": "...", "title": "New Post", "status": "published" }
  },
  "timestamp": "2026-03-03T14:30:00Z"
}

// Presence (who's online)
{
  "type": "presence",
  "channel": "room:123",
  "joins": [{ "user_id": "...", "name": "Nic" }],
  "leaves": []
}
```

### 6.4 Edge Functions (Phase 4+)

**Purpose:** Server-side functions triggered by schema hooks or HTTP endpoints.

**Technology:** Deno runtime (same as Supabase Edge Functions). Deno provides sandboxed execution, TypeScript support out of the box, and a secure-by-default permissions model that prevents functions from accessing the filesystem or network unless explicitly allowed.

**Integration with schema hooks:**

```typescript
// In the schema definition:
export const Post = model('post', {
  // ...fields...
  hooks: {
    afterCreate: 'notify-subscribers',
    onPublish: 'send-newsletter',
  }
})

// In functions/notify-subscribers.ts:
import { serve } from '@[platform]/functions'

serve(async (event) => {
  const post = event.record    // the newly created post
  const author = event.related.author

  // Send notification via external service
  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${Deno.env.get('SENDGRID_KEY')}` },
    body: JSON.stringify({
      to: event.subscribers,     // platform provides subscriber list
      subject: `New post by ${author.name}`,
      html: `<h1>${post.title}</h1><p>${post.excerpt}</p>`,
    }),
  })

  return { success: true }
})
```

---

## 7. Client SDK & React Hooks

### 7.1 Generated Type Definitions

After every `push`, the Rust engine generates a TypeScript file:

```typescript
// .platform/types/database.gen.ts
// AUTO-GENERATED — DO NOT EDIT
// Generated by platform-engine v0.1.0
// Schema hash: sha256:abc123...

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export interface StorageReference {
  bucket: string
  path: string
  originalName: string
  size: number
  mimeType: string
  url: string
  transforms?: Record<string, string>  // { thumbnail: url, medium: url }
}

export interface RichTextContent {
  root: {
    type: string
    children: RichTextNode[]
    [key: string]: unknown
  }
}

export interface RichTextNode {
  type: string
  children?: RichTextNode[]
  text?: string
  [key: string]: unknown
}

export interface Database {
  public: {
    Tables: {
      users: {
        Row: {
          id: string
          email: string
          name: string
          avatar: StorageReference | null
          role: 'admin' | 'editor' | 'member'
          bio: string | null
          created_at: string
          updated_at: string
          deleted_at: string | null
        }
        Insert: {
          id?: string
          email: string
          name: string
          avatar?: StorageReference | null
          role?: 'admin' | 'editor' | 'member'
          bio?: string | null
        }
        Update: {
          id?: string
          email?: string
          name?: string
          avatar?: StorageReference | null
          role?: 'admin' | 'editor' | 'member'
          bio?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'posts_author_id_fkey'
            columns: ['id']
            referencedRelation: 'posts'
            referencedColumns: ['author_id']
            isOneToMany: true
          }
        ]
      }
      posts: {
        Row: {
          id: string
          title: string
          slug: string
          content: RichTextContent
          excerpt: string | null
          cover_image: StorageReference | null
          author_id: string
          tags: string[] | null
          status: 'draft' | 'published' | 'scheduled' | 'archived'
          published_at: string | null
          scheduled_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          title: string
          content: RichTextContent
          author_id: string
          slug?: string
          excerpt?: string | null
          cover_image?: StorageReference | null
          tags?: string[] | null
          status?: 'draft' | 'published' | 'scheduled' | 'archived'
          published_at?: string | null
          scheduled_at?: string | null
        }
        Update: {
          title?: string
          content?: RichTextContent
          author_id?: string
          slug?: string
          excerpt?: string | null
          cover_image?: StorageReference | null
          tags?: string[] | null
          status?: 'draft' | 'published' | 'scheduled' | 'archived'
          published_at?: string | null
          scheduled_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'posts_author_id_fkey'
            columns: ['author_id']
            referencedRelation: 'users'
            referencedColumns: ['id']
            isOneToMany: false
          }
        ]
      }
      categories: {
        Row: {
          id: string
          name: string
          slug: string
          description: string | null
          parent_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          slug?: string
          description?: string | null
          parent_id?: string | null
        }
        Update: {
          name?: string
          slug?: string
          description?: string | null
          parent_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'categories_parent_id_fkey'
            columns: ['parent_id']
            referencedRelation: 'categories'
            referencedColumns: ['id']
            isOneToMany: false
          }
        ]
      }
      post_categories: {
        Row: {
          post_id: string
          category_id: string
        }
        Insert: {
          post_id: string
          category_id: string
        }
        Update: {
          post_id?: string
          category_id?: string
        }
        Relationships: []
      }
      comments: {
        Row: {
          id: string
          body: string
          author_id: string
          post_id: string
          parent_id: string | null
          created_at: string
          updated_at: string
          deleted_at: string | null
        }
        Insert: {
          id?: string
          body: string
          author_id: string
          post_id: string
          parent_id?: string | null
        }
        Update: {
          body?: string
          parent_id?: string | null
        }
        Relationships: []
      }
    }
  }
}
```

### 7.2 Client SDK (@[platform]/client)

The client SDK wraps PostgREST's API with type-safe methods. Since PostgREST already provides the REST API, the client is primarily a typed HTTP wrapper — similar to supabase-js.

```typescript
// packages/client/src/index.ts

import type { Database } from './types'   // generated types

export function createClient<TDatabase = Database>(config: {
  url: string
  anonKey: string
  auth?: {
    persistSession?: boolean
    storageKey?: string
  }
}) {
  const headers = {
    'apikey': config.anonKey,
    'Content-Type': 'application/json',
  }

  return {
    // Data queries — wraps PostgREST
    from: <T extends keyof TDatabase['public']['Tables']>(table: T) => ({
      select: (columns?: string) => new QueryBuilder<TDatabase['public']['Tables'][T]['Row']>(
        config.url, `/rest/v1/${String(table)}`, headers, columns
      ),
      insert: (data: TDatabase['public']['Tables'][T]['Insert'] | TDatabase['public']['Tables'][T]['Insert'][]) =>
        new MutationBuilder(config.url, `/rest/v1/${String(table)}`, headers, 'POST', data),
      update: (data: TDatabase['public']['Tables'][T]['Update']) =>
        new MutationBuilder(config.url, `/rest/v1/${String(table)}`, headers, 'PATCH', data),
      delete: () =>
        new MutationBuilder(config.url, `/rest/v1/${String(table)}`, headers, 'DELETE'),
      upsert: (data: TDatabase['public']['Tables'][T]['Insert'] | TDatabase['public']['Tables'][T]['Insert'][]) =>
        new MutationBuilder(config.url, `/rest/v1/${String(table)}`, headers, 'POST', data, { upsert: true }),
    }),

    // Auth — wraps GoTrue
    auth: new AuthClient(config.url + '/auth/v1', headers),

    // Storage — wraps storage service
    storage: new StorageClient(config.url + '/storage/v1', headers),

    // Realtime — WebSocket client
    realtime: new RealtimeClient(config.url + '/realtime/v1', headers),
  }
}

// Usage:
import { createClient } from '@[platform]/client'
import type { Database } from './.platform/types/database.gen'

const client = createClient<Database>({
  url: process.env.NEXT_PUBLIC_PLATFORM_URL!,
  anonKey: process.env.NEXT_PUBLIC_PLATFORM_ANON_KEY!,
})

// Fully typed — TypeScript knows the shape
const { data: posts, error } = await client
  .from('posts')
  .select('*, author:users(name, email), categories(name)')
  .eq('status', 'published')
  .order('published_at', { ascending: false })
  .limit(10)

// posts is typed as Array<Post['Row'] & { author: Pick<User['Row'], 'name' | 'email'>, categories: Pick<Category['Row'], 'name'>[] }>

// GraphQL alternative (same auth, same RLS, same types):
const { data: gqlPosts } = await client.graphql(`
  query {
    postCollection(filter: { status: { eq: "published" } }, first: 10) {
      edges {
        node {
          title
          slug
          author { name email }
          categoryCollection { edges { node { name } } }
        }
      }
    }
  }
`)
```

### 7.3 React Hooks (@[platform]/react)

```typescript
// packages/react/src/index.ts

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import type { PlatformClient } from '@[platform]/client'

// Provider
const PlatformContext = createContext<PlatformClient | null>(null)

export function PlatformProvider({
  client,
  children
}: {
  client: PlatformClient
  children: React.ReactNode
}) {
  return (
    <PlatformContext.Provider value={client}>
      {children}
    </PlatformContext.Provider>
  )
}

// useQuery — fetch data with automatic typing
export function useQuery<
  TTable extends keyof Database['public']['Tables'],
  TRow = Database['public']['Tables'][TTable]['Row']
>(
  table: TTable,
  options?: {
    select?: string
    filter?: Record<string, any>
    order?: { column: string; ascending?: boolean }
    limit?: number
    offset?: number
    enabled?: boolean
    refetchInterval?: number
  }
) {
  const client = useContext(PlatformContext)
  const [data, setData] = useState<TRow[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    if (!client || options?.enabled === false) return

    setLoading(true)
    let query = client.from(table).select(options?.select ?? '*')

    if (options?.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        query = query.eq(key, value)
      }
    }
    if (options?.order) {
      query = query.order(options.order.column, { ascending: options.order.ascending ?? true })
    }
    if (options?.limit) query = query.limit(options.limit)
    if (options?.offset) query = query.range(options.offset, options.offset + (options.limit ?? 10) - 1)

    const { data, error } = await query
    setData(data as TRow[])
    setError(error)
    setLoading(false)
  }, [client, table, JSON.stringify(options)])

  useEffect(() => { fetch() }, [fetch])

  return { data, error, loading, refetch: fetch }
}

// useMutation — create/update/delete with typing
export function useMutation<
  TTable extends keyof Database['public']['Tables']
>(
  table: TTable,
  operation: 'insert' | 'update' | 'delete' | 'upsert'
) {
  const client = useContext(PlatformContext)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const mutate = useCallback(async (
    data?: any,
    options?: { filter?: Record<string, any> }
  ) => {
    if (!client) return { data: null, error: new Error('Client not initialised') }

    setLoading(true)
    setError(null)

    let result
    switch (operation) {
      case 'insert':
        result = await client.from(table).insert(data)
        break
      case 'update':
        let updateQuery = client.from(table).update(data)
        if (options?.filter) {
          for (const [key, value] of Object.entries(options.filter)) {
            updateQuery = updateQuery.eq(key, value)
          }
        }
        result = await updateQuery
        break
      case 'delete':
        let deleteQuery = client.from(table).delete()
        if (options?.filter) {
          for (const [key, value] of Object.entries(options.filter)) {
            deleteQuery = deleteQuery.eq(key, value)
          }
        }
        result = await deleteQuery
        break
      case 'upsert':
        result = await client.from(table).upsert(data)
        break
    }

    setLoading(false)
    if (result.error) setError(result.error)
    return result
  }, [client, table, operation])

  return { mutate, loading, error }
}

// useAuth — authentication state and methods
export function useAuth() {
  const client = useContext(PlatformContext)
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!client) return
    client.auth.getUser().then(({ data }) => {
      setUser(data?.user ?? null)
      setLoading(false)
    })
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [client])

  return {
    user,
    loading,
    signIn: (opts: any) => client!.auth.signInWithPassword(opts),
    signUp: (opts: any) => client!.auth.signUp(opts),
    signOut: () => client!.auth.signOut(),
    signInWithOAuth: (opts: any) => client!.auth.signInWithOAuth(opts),
    signInWithMagicLink: (opts: any) => client!.auth.signInWithOtp(opts),
  }
}

// useSubscription — realtime data subscriptions
export function useSubscription<
  TTable extends keyof Database['public']['Tables']
>(
  table: TTable,
  options: {
    event: 'INSERT' | 'UPDATE' | 'DELETE' | '*'
    filter?: Record<string, any>
    onData: (payload: any) => void
  }
) {
  const client = useContext(PlatformContext)

  useEffect(() => {
    if (!client) return

    const channel = client.realtime
      .channel(`public:${String(table)}`)
      .on('postgres_changes', {
        event: options.event,
        schema: 'public',
        table: String(table),
        filter: options.filter ? Object.entries(options.filter).map(([k, v]) => `${k}=eq.${v}`).join('&') : undefined,
      }, options.onData)
      .subscribe()

    return () => { channel.unsubscribe() }
  }, [client, table, options.event])
}
```

### 7.4 Pre-built Auth Components (@[platform]/react-auth)

```typescript
// Optional package with drop-in auth UI components
// Similar to @supabase/auth-ui-react

import { LoginForm, SignUpForm, ForgotPasswordForm, AuthProvider } from '@[platform]/react-auth'

function App() {
  return (
    <PlatformProvider client={client}>
      <AuthProvider
        redirectTo="/dashboard"
        providers={['google', 'github']}
        appearance={{
          theme: 'dark',
          variables: {
            brandColor: '#6366f1',
            borderRadius: '8px',
          }
        }}
      >
        <LoginForm />
      </AuthProvider>
    </PlatformProvider>
  )
}
```

---

## 8. Admin Panel (Auto-Generated)

### 8.1 Overview

The admin panel is a React (Next.js) application that renders entirely from configuration generated by the Rust schema engine. No code generation — the panel reads a JSON config at runtime and dynamically renders the appropriate UI.

### 8.2 Admin Configuration JSON

Generated by `platform-engine admin`:

```json
{
  "version": "1.0",
  "models": [
    {
      "name": "post",
      "label": "Posts",
      "labelPlural": "Posts",
      "slug": "posts",
      "tableName": "posts",
      "icon": "file-text",
      "listView": {
        "columns": [
          { "field": "title", "label": "Title", "sortable": true, "searchable": true },
          { "field": "status", "label": "Status", "sortable": true, "filterable": true,
            "render": "badge", "badgeMap": {
              "draft": { "color": "gray", "label": "Draft" },
              "published": { "color": "green", "label": "Published" },
              "scheduled": { "color": "blue", "label": "Scheduled" },
              "archived": { "color": "red", "label": "Archived" }
            }
          },
          { "field": "author", "label": "Author", "relation": "users", "display": "name" },
          { "field": "published_at", "label": "Published", "sortable": true, "render": "date" },
          { "field": "created_at", "label": "Created", "sortable": true, "render": "date" }
        ],
        "defaultSort": { "field": "created_at", "direction": "desc" },
        "searchFields": ["title", "excerpt"],
        "filters": [
          { "field": "status", "type": "select", "options": ["draft", "published", "scheduled", "archived"] },
          { "field": "author_id", "type": "relation", "target": "users", "display": "name" }
        ],
        "bulkActions": ["publish", "unpublish", "delete"]
      },
      "editView": {
        "layout": [
          {
            "type": "main",
            "fields": [
              { "field": "title", "widget": "text", "required": true, "placeholder": "Enter post title..." },
              { "field": "slug", "widget": "slug", "source": "title", "required": true },
              { "field": "content", "widget": "richText", "required": true }
            ]
          },
          {
            "type": "sidebar",
            "fields": [
              { "field": "status", "widget": "publishFlow",
                "transitions": {
                  "draft": ["published", "scheduled"],
                  "published": ["draft", "archived"],
                  "scheduled": ["draft", "published"],
                  "archived": ["draft"]
                }
              },
              { "field": "author_id", "widget": "relation", "target": "users", "display": "name", "required": true },
              { "field": "categories", "widget": "relationMulti", "target": "categories", "display": "name" },
              { "field": "cover_image", "widget": "image", "bucket": "post-cover-images" },
              { "field": "excerpt", "widget": "textarea", "maxLength": 280, "showCount": true },
              { "field": "tags", "widget": "tags" }
            ]
          }
        ],
        "versions": true,
        "preview": {
          "url": "/posts/:slug",
          "fields": { "slug": "slug" }
        }
      }
    }
  ],
  "navigation": [
    { "label": "Content", "items": [
      { "model": "post", "icon": "file-text" },
      { "model": "category", "icon": "folder" }
    ]},
    { "label": "Users", "items": [
      { "model": "user", "icon": "users" },
      { "model": "comment", "icon": "message-circle" }
    ]}
  ],
  "branding": {
    "name": "My App",
    "logo": null,
    "primaryColor": "#6366f1"
  }
}
```

### 8.3 Admin Panel Widgets

Each field type maps to a widget:

| Field Type | Widget | Description |
|---|---|---|
| `text` | Text input | Single line text |
| `text` (maxLength) | Textarea with counter | Multi-line with character count |
| `richText` | Lexical editor | Full rich text with blocks, embeds, media. MIT licensed, Meta-backed. |
| `integer` / `float` | Number input | With min/max validation |
| `boolean` | Toggle switch | |
| `datetime` | Date/time picker | |
| `email` | Email input | With format validation |
| `slug` | Slug input | Auto-generates from source, editable |
| `enum` | Select dropdown | Options from enum values |
| `json` | JSON editor | CodeMirror with validation |
| `image` | Image uploader | Drag & drop, preview, crop |
| `file` | File uploader | Drag & drop, file type validation |
| `geo` | Map picker | Leaflet/Mapbox for point/polygon selection |
| `vector` | Hidden/read-only | Not user-editable |
| `belongsTo` | Relation picker | Search + select from related table |
| `manyToMany` | Multi-relation picker | Tag-style selection |
| `publishable` | Publish flow | Status badge + transition buttons |
| `timestamps` | Read-only display | Created/updated dates |

### 8.4 Customisation

Developers can override admin panel behaviour via a config file:

```typescript
// platform.admin.ts — optional customisation

import { defineAdmin } from '@[platform]/admin'

export default defineAdmin({
  branding: {
    name: 'My Blog',
    logo: './assets/logo.svg',
    primaryColor: '#6366f1',
    darkMode: true,
  },

  models: {
    post: {
      // Override list columns
      listView: {
        columns: ['title', 'status', 'author', 'published_at'],
      },
      // Custom field widget
      editView: {
        fields: {
          content: {
            widget: 'richText',
            config: {
              toolbar: ['bold', 'italic', 'link', 'image', 'code', 'heading'],
              blocks: ['image', 'video', 'code', 'quote'],
            }
          }
        }
      }
    },
  },

  navigation: [
    { label: 'Content', models: ['post', 'category'] },
    { label: 'Community', models: ['comment'] },
    { label: 'Users', models: ['user'] },
  ],

  dashboard: {
    widgets: [
      { type: 'stat', model: 'post', filter: { status: 'published' }, label: 'Published Posts' },
      { type: 'stat', model: 'user', label: 'Total Users' },
      { type: 'recent', model: 'post', limit: 5, label: 'Recent Posts' },
      { type: 'chart', model: 'post', groupBy: 'created_at', period: '30d', label: 'Posts This Month' },
    ]
  }
})
```

---

## 9. Developer Dashboard (Studio)

### 9.1 Overview

The Studio is the developer-facing management UI. It is distinct from the Admin Panel (which is for content editors). The Studio provides:

1. **Visual Schema Designer** — drag-and-drop model builder
2. **Data Explorer** — browse tables, inspect records, run raw SQL
3. **Migration History** — view all migrations, rollback capability
4. **Auth Management** — view users, manage roles, configure providers
5. **Storage Browser** — browse buckets, upload/delete files
6. **API Documentation** — auto-generated from schema (Swagger/OpenAPI)
7. **Logs** — API request logs, auth logs, error logs
8. **Settings** — project configuration, environment variables, API keys

### 9.2 Visual Schema Designer

The visual designer is a React application that allows developers to define models graphically. It outputs the same JSON AST that the TypeScript schema files produce, meaning both code-first and visual-first workflows produce identical results.

```
┌─────────────────────────────────────────────────────────────────┐
│ Schema Designer                                    [Save] [Push]│
├──────────────────────┬──────────────────────────────────────────┤
│                      │                                          │
│  Models              │  ┌──────────────────────────────────┐    │
│  ──────              │  │ Post                              │    │
│  ▸ User              │  ├──────────────────────────────────┤    │
│  ▸ Post   ← active   │  │ id          UUID     PK          │    │
│  ▸ Category          │  │ title       TEXT     required     │    │
│  ▸ Comment           │  │ slug        SLUG    ← title      │    │
│                      │  │ content     RICH    required     │    │
│  [+ Add Model]       │  │ excerpt     TEXT    max:280      │    │
│                      │  │ cover_image IMAGE                │    │
│                      │  │ author      → User  required     │    │
│                      │  │ categories  ↔ Category           │    │
│                      │  │ tags        JSON                 │    │
│                      │  │ status      ENUM   publishable   │    │
│                      │  │ created_at  TIME   auto          │    │
│                      │  │ updated_at  TIME   auto          │    │
│                      │  │                                  │    │
│                      │  │ [+ Add Field]                    │    │
│                      │  └──────────────────────────────────┘    │
│                      │                                          │
│                      │  Access Rules                            │
│                      │  ────────────                            │
│                      │  Read:   Public (published) | Owner      │
│                      │  Create: Admin, Editor, Member           │
│                      │  Update: Owner | Admin, Editor           │
│                      │  Delete: Admin                           │
│                      │                                          │
│                      │  Indexes                                 │
│                      │  ───────                                 │
│                      │  status + published_at (btree)           │
│                      │  content (GIN, full-text)                │
│                      │                                          │
└──────────────────────┴──────────────────────────────────────────┘
```

**Future enhancement (requires Rust → WASM):** The visual designer could run the schema engine's diff algorithm in the browser via WASM, showing real-time migration previews as the developer makes changes. This is where the Rust choice pays off later.

---

## 10. CLI

### 10.1 Command Reference

```
npx @[platform]/cli <command> [options]

Project Setup:
  init <name>             Create a new project
  dev                     Start local development environment (Docker Compose)
  stop                    Stop local development environment

Schema:
  push                    Diff schema → generate migration → apply → regenerate
  pull                    Introspect database → generate schema files (reverse engineering)
                          Generates full TypeScript schema files with best-effort inference.
                          Fields, relations, and constraints are fully inferred. Access rules
                          and hooks are scaffolded with sensible defaults (access.authenticated()
                          for all operations) and marked with TODO comments for manual review.
  diff                    Preview what push would do (dry run)
  generate                Regenerate TypeScript types from current schema (no migration)

Migrations:
  migrate                 Apply all pending migrations
  migrate:status          Show migration status
  migrate:create <name>   Create an empty migration file (for custom SQL)
  rollback                Rollback the last migration
  rollback:all            Rollback all migrations
  reset                   Drop all tables + reapply all migrations + seed

Database:
  db:seed                 Run seed file (seed/index.ts)
  db:studio               Open database in external tool (pgAdmin, TablePlus, etc.)
  db:dump                 Export database to SQL file
  db:restore <file>       Import database from SQL file

Auth:
  auth:users              List users
  auth:create-user        Create a user interactively
  auth:set-role           Assign role to user

Cloud:
  link                    Link local project to cloud project
  deploy                  Push schema + migrations to cloud
  deploy:preview          Create a preview environment (branch)
  env:pull                Pull environment variables from cloud
  env:push                Push local env to cloud
  logs                    Tail cloud logs
  status                  Show cloud project status

Utilities:
  studio                  Open Studio dashboard in browser
  admin                   Open Admin panel in browser
  docs                    Open auto-generated API documentation
  update                  Update CLI and engine binary
```

### 10.2 Project Configuration

```typescript
// platform.config.ts

import { defineConfig } from '@[platform]/cli'

export default defineConfig({
  // Project identity (set during `init` or `link`)
  projectId: 'my-project-abc123',

  // Schema file location
  schema: './schema/index.ts',

  // Database connection (local dev — cloud is managed)
  database: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/platform',
  },

  // Auth configuration
  auth: {
    providers: ['google', 'github'],
    redirectUrl: 'http://localhost:3000/auth/callback',
    jwtExpiry: 3600,
  },

  // Storage configuration
  storage: {
    provider: 'minio',      // 'minio' for self-host, 's3' or 'r2' for cloud
    endpoint: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
  },

  // Seed configuration
  seed: {
    file: './seed/index.ts',
    environments: ['development', 'test'],   // never run in production
  },

  // Admin panel customisation
  admin: './platform.admin.ts',

  // Engine configuration
  engine: {
    renameDetectionThreshold: 0.7,     // Levenshtein similarity for rename detection
    indexConcurrently: true,            // Use CONCURRENTLY for index operations
  },
})
```

---

## 11. Cloud Offering & Infrastructure

### 11.1 Multi-Tenancy Architecture

**Cloud Provider: Hetzner**

Hetzner provides dedicated servers and managed Kubernetes (K3s) at significantly lower cost than AWS/GCP, with EU data centres (Falkenstein, Nuremberg, Helsinki). This gives us a strong GDPR/data sovereignty positioning that Supabase (default us-east-1 on AWS) lacks. The trade-off is fewer global regions — US expansion would require adding a second provider later.

**Free Tier: Shared Kubernetes Cluster (Hetzner)**

```
┌─────────────────────────────────────────────────────────────┐
│                   Kubernetes Cluster                         │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Shared Services                                     │    │
│  │  Kong (shared) → PostgREST (per-project pod)        │    │
│  │                → GoTrue (per-project pod)            │    │
│  │                → Storage (shared, bucket-isolated)   │    │
│  │                → Realtime (shared, channel-isolated) │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Database: Shared Postgres with schema isolation     │    │
│  │                                                      │    │
│  │  project_abc123.users                                │    │
│  │  project_abc123.posts                                │    │
│  │  project_def456.products                             │    │
│  │  project_def456.orders                               │    │
│  │                                                      │    │
│  │  Resource limits per project:                        │    │
│  │  - 500MB storage                                     │    │
│  │  - Connection pooling (max 10 connections)           │    │
│  │  - Statement timeout (30s)                           │    │
│  │  - Row count limits per table                        │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Object Storage: Shared MinIO / R2                   │    │
│  │  Bucket prefix per project: project_abc123/          │    │
│  │  Bandwidth quotas enforced at proxy level            │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

**Pro/Team Tier: Dedicated Resources**

```
┌─────────────────────────────────────────────────────────────┐
│                   Kubernetes Cluster                         │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Project: abc123 (Pro tier)                          │    │
│  │                                                      │    │
│  │  ┌──────────────────────────────────────────────┐   │    │
│  │  │  Dedicated Postgres (Neon or RDS)             │   │    │
│  │  │  - 8GB storage                                │   │    │
│  │  │  - Connection pooling (100 connections)       │   │    │
│  │  │  - Daily automated backups                    │   │    │
│  │  │  - Point-in-time recovery                     │   │    │
│  │  └──────────────────────────────────────────────┘   │    │
│  │                                                      │    │
│  │  ┌──────────────────────────────────────────────┐   │    │
│  │  │  Dedicated pods:                              │   │    │
│  │  │  - PostgREST (dedicated, auto-scaling)       │   │    │
│  │  │  - GoTrue (dedicated)                         │   │    │
│  │  │  - Realtime (dedicated, WebSocket affinity)  │   │    │
│  │  └──────────────────────────────────────────────┘   │    │
│  │                                                      │    │
│  │  Storage: Dedicated R2/S3 bucket                     │    │
│  │  Custom domain: api.myapp.com                        │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

**Enterprise: Single-Tenant**

Fully isolated Kubernetes namespace or dedicated cluster. VPC peering, private networking, custom compliance requirements.

### 11.2 Cloud Control Plane

The control plane manages project provisioning, scaling, and lifecycle:

```
┌──────────────────────────────────────────────────────────────┐
│                    Cloud Control Plane                        │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Project       │  │ Provisioner  │  │ Billing Service   │  │
│  │ Manager       │  │              │  │                   │  │
│  │              │  │ Create DB    │  │ Stripe integration│  │
│  │ CRUD projects│  │ Deploy pods  │  │ Usage metering    │  │
│  │ API keys     │  │ Configure    │  │ Invoice generation│  │
│  │ Environments │  │ DNS/SSL      │  │ Tier management   │  │
│  └──────────────┘  └──────────────┘  └───────────────────┘  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Deploy       │  │ Monitoring   │  │ Backup Service    │  │
│  │ Pipeline     │  │              │  │                   │  │
│  │              │  │ Prometheus   │  │ Automated backups │  │
│  │ Schema push  │  │ Grafana      │  │ PITR              │  │
│  │ Migration    │  │ Alerting     │  │ Cross-region      │  │
│  │ Rollback     │  │ Log aggreg.  │  │ replication       │  │
│  └──────────────┘  └──────────────┘  └───────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 11.3 Pricing Tiers (Hybrid: Base Monthly + Usage Overages)

| | Free | Pro (£25/mo) | Team (£75/mo) | Enterprise |
|---|---|---|---|---|
| **Infrastructure** | Shared K8s | Dedicated DB | Dedicated everything | Single-tenant |
| **Database** | 500MB shared | 8GB dedicated | 50GB dedicated | Custom |
| **Compute** | Shared pods | Dedicated pods | Auto-scaling | Custom |
| **Storage** | 1GB (R2) | 50GB | 500GB | Custom |
| **Bandwidth** | 5GB/mo | 50GB/mo | 500GB/mo | Custom |
| **Models** | Unlimited | Unlimited | Unlimited | Unlimited |
| **Auth users** | 1,000 | 50,000 | Unlimited | Unlimited |
| **API requests** | 100K/mo | 2M/mo | Unlimited | Unlimited |
| **Realtime** | 50 concurrent | 500 concurrent | 5,000 concurrent | Custom |
| **Backups** | None | Daily | Hourly + PITR | Custom |
| **Custom domains** | — | 1 | Unlimited | Unlimited |
| **Edge functions** | — | 10 | Unlimited | Unlimited |
| **Audit logs** | — | — | — | ✓ |
| **SSO/SAML** | — | — | — | ✓ |
| **SLA** | — | — | 99.9% | 99.99% |
| **Support** | Community | Email (48h) | Priority (4h) | Dedicated |
| **Project limit** | 2 (pause after 7d inactivity) | 10 | Unlimited | Unlimited |

**Overage pricing (Pro and above):**
- Database storage: £0.125/GB beyond included
- File storage: £0.02/GB beyond included
- Bandwidth: £0.09/GB beyond included
- Auth MAUs: £0.00325/user beyond included
- Edge function invocations: £2/million beyond included

---

## 12. Self-Hosting (Secondary Priority)

Self-hosting is supported via Docker Compose but is not the primary focus. The cloud offering is the priority product. Self-hosting documentation will be maintained but features like one-click VPS provisioning are not planned for v1.

### 12.1 Docker Compose (Complete)

```yaml
# docker-compose.yml
# Complete self-hosted platform stack

version: '3.8'

services:
  # ──────────────────────────────────────────────
  # Database
  # ──────────────────────────────────────────────
  postgres:
    image: [platform]/postgres:16
    # Custom image with extensions pre-installed:
    # uuid-ossp, pgcrypto, pgjwt, postgis, pgvector, pg_cron, pg_net, pg_graphql
    restart: unless-stopped
    ports:
      - "${POSTGRES_PORT:-5432}:5432"
    volumes:
      - db_data:/var/lib/postgresql/data
      - ./volumes/db/init:/docker-entrypoint-initdb.d    # init scripts
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: platform
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  # ──────────────────────────────────────────────
  # API Gateway
  # ──────────────────────────────────────────────
  kong:
    image: kong:3.6-alpine
    restart: unless-stopped
    ports:
      - "${API_PORT:-8000}:8000"      # Public API
      - "${API_SSL_PORT:-8443}:8443"  # Public API (SSL)
    environment:
      KONG_DATABASE: "off"
      KONG_DECLARATIVE_CONFIG: /etc/kong/kong.yml
      KONG_PROXY_ACCESS_LOG: /dev/stdout
      KONG_PROXY_ERROR_LOG: /dev/stderr
    volumes:
      - ./volumes/kong/kong.yml:/etc/kong/kong.yml:ro
    depends_on:
      postgrest:
        condition: service_started
      auth:
        condition: service_started

  # ──────────────────────────────────────────────
  # REST API (PostgREST)
  # ──────────────────────────────────────────────
  postgrest:
    image: postgrest/postgrest:v12
    restart: unless-stopped
    environment:
      PGRST_DB_URI: postgres://authenticator:${AUTHENTICATOR_PASSWORD}@postgres:5432/platform
      PGRST_DB_SCHEMAS: public
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: ${JWT_SECRET}
      PGRST_JWT_AUD: authenticated
      PGRST_DB_CHANNEL_ENABLED: "true"      # Listen for schema reload notifications
    depends_on:
      postgres:
        condition: service_healthy

  # ──────────────────────────────────────────────
  # Auth (GoTrue fork)
  # ──────────────────────────────────────────────
  auth:
    image: [platform]/auth:latest
    restart: unless-stopped
    environment:
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgres://gotrue:${GOTRUE_PASSWORD}@postgres:5432/platform
      GOTRUE_SITE_URL: ${SITE_URL:-http://localhost:3000}
      GOTRUE_URI_ALLOW_LIST: ${AUTH_REDIRECT_URLS}
      GOTRUE_JWT_SECRET: ${JWT_SECRET}
      GOTRUE_JWT_EXP: ${JWT_EXPIRY:-3600}
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_EXTERNAL_GOOGLE_ENABLED: ${GOOGLE_AUTH_ENABLED:-false}
      GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}
      GOTRUE_EXTERNAL_GOOGLE_SECRET: ${GOOGLE_CLIENT_SECRET}
      GOTRUE_EXTERNAL_GITHUB_ENABLED: ${GITHUB_AUTH_ENABLED:-false}
      GOTRUE_EXTERNAL_GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID}
      GOTRUE_EXTERNAL_GITHUB_SECRET: ${GITHUB_CLIENT_SECRET}
      GOTRUE_MAILER_AUTOCONFIRM: ${MAILER_AUTOCONFIRM:-true}
      GOTRUE_SMTP_HOST: ${SMTP_HOST}
      GOTRUE_SMTP_PORT: ${SMTP_PORT:-587}
      GOTRUE_SMTP_USER: ${SMTP_USER}
      GOTRUE_SMTP_PASS: ${SMTP_PASS}
      GOTRUE_SMTP_SENDER_NAME: ${SMTP_SENDER_NAME:-Platform}
    depends_on:
      postgres:
        condition: service_healthy

  # ──────────────────────────────────────────────
  # Realtime
  # ──────────────────────────────────────────────
  realtime:
    image: [platform]/realtime:latest
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://realtime:${REALTIME_PASSWORD}@postgres:5432/platform
      JWT_SECRET: ${JWT_SECRET}
      PORT: 4000
      REPLICATION_MODE: RLS        # Respect row-level security
      REPLICATION_POLL_INTERVAL: 100
      SECURE_CHANNELS: "true"
      SLOT_NAME: realtime_slot
    depends_on:
      postgres:
        condition: service_healthy

  # ──────────────────────────────────────────────
  # Storage
  # ──────────────────────────────────────────────
  storage:
    image: [platform]/storage:latest
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://storage:${STORAGE_DB_PASSWORD}@postgres:5432/platform
      STORAGE_BACKEND: s3
      S3_ENDPOINT: http://minio:9000
      S3_REGION: us-east-1
      S3_ACCESS_KEY: ${MINIO_ACCESS_KEY}
      S3_SECRET_KEY: ${MINIO_SECRET_KEY}
      S3_BUCKET: platform-storage
      JWT_SECRET: ${JWT_SECRET}
      IMAGE_TRANSFORMATION_ENABLED: "true"
      PORT: 5000
    depends_on:
      postgres:
        condition: service_healthy
      minio:
        condition: service_started

  # ──────────────────────────────────────────────
  # Object Storage (MinIO)
  # ──────────────────────────────────────────────
  minio:
    image: minio/minio:latest
    restart: unless-stopped
    ports:
      - "${MINIO_PORT:-9000}:9000"
      - "${MINIO_CONSOLE_PORT:-9001}:9001"
    volumes:
      - storage_data:/data
    environment:
      MINIO_ROOT_USER: ${MINIO_ACCESS_KEY}
      MINIO_ROOT_PASSWORD: ${MINIO_SECRET_KEY}
    command: server /data --console-address ":9001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 10s
      retries: 3

  # ──────────────────────────────────────────────
  # Studio (Developer Dashboard)
  # ──────────────────────────────────────────────
  studio:
    image: [platform]/studio:latest
    restart: unless-stopped
    ports:
      - "${STUDIO_PORT:-3100}:3100"
    environment:
      PLATFORM_URL: http://kong:8000
      POSTGRES_URL: postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/platform
      SERVICE_ROLE_KEY: ${SERVICE_ROLE_KEY}
      ANON_KEY: ${ANON_KEY}
    depends_on:
      - kong

  # ──────────────────────────────────────────────
  # Admin Panel (Content Management)
  # ──────────────────────────────────────────────
  admin:
    image: [platform]/admin:latest
    restart: unless-stopped
    ports:
      - "${ADMIN_PORT:-3200}:3200"
    environment:
      PLATFORM_URL: http://kong:8000
      SERVICE_ROLE_KEY: ${SERVICE_ROLE_KEY}
      ADMIN_CONFIG_PATH: /etc/admin/config.json
    volumes:
      - ./volumes/admin/config.json:/etc/admin/config.json:ro
    depends_on:
      - kong

volumes:
  db_data:
    driver: local
  storage_data:
    driver: local
```

### 12.2 Environment File Template

```bash
# .env.example — copy to .env and fill in values

# ──── Security ────
# Generate with: openssl rand -base64 64
JWT_SECRET=your-super-secret-jwt-key
ANON_KEY=your-anon-key
SERVICE_ROLE_KEY=your-service-role-key

# ──── Database ────
POSTGRES_PASSWORD=your-postgres-password
AUTHENTICATOR_PASSWORD=your-authenticator-password
GOTRUE_PASSWORD=your-gotrue-password
REALTIME_PASSWORD=your-realtime-password
STORAGE_DB_PASSWORD=your-storage-password

# ──── Storage ────
MINIO_ACCESS_KEY=your-minio-access-key
MINIO_SECRET_KEY=your-minio-secret-key

# ──── Auth ────
SITE_URL=http://localhost:3000
AUTH_REDIRECT_URLS=http://localhost:3000/auth/callback

# Google OAuth (optional)
GOOGLE_AUTH_ENABLED=false
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# GitHub OAuth (optional)
GITHUB_AUTH_ENABLED=false
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# ──── Email ────
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_SENDER_NAME=Platform
MAILER_AUTOCONFIRM=true

# ──── Ports ────
API_PORT=8000
POSTGRES_PORT=5432
STUDIO_PORT=3100
ADMIN_PORT=3200
MINIO_PORT=9000
MINIO_CONSOLE_PORT=9001
```

---

## 13. Security Model

### 13.1 Authentication Flow

```
┌──────────┐     ┌──────┐     ┌────────┐     ┌──────────┐
│  Client   │────▶│ Kong │────▶│ GoTrue │────▶│ Postgres │
│  App      │     │      │     │        │     │ auth.*   │
└──────────┘     └──────┘     └────────┘     └──────────┘
     │                              │
     │ JWT returned                 │ User created/verified
     │◀─────────────────────────────┘
     │
     │ Subsequent requests include JWT in Authorization header
     │
     ▼
┌──────────┐     ┌──────┐     ┌──────────┐     ┌──────────┐
│  Client   │────▶│ Kong │────▶│ PostgREST│────▶│ Postgres │
│  App      │     │      │     │          │     │ public.* │
└──────────┘     │ JWT  │     │ Sets     │     │ RLS      │
                 │ valid│     │ role +   │     │ enforced │
                 └──────┘     │ claims   │     └──────────┘
                              └──────────┘
```

### 13.2 Row Level Security — From Schema to SQL

The schema's `access` rules translate directly to Postgres RLS policies:

```typescript
// Schema definition
access: {
  read: access.any(
    access.custom("status = 'published'"),
    access.owner('author_id'),
    access.role(['admin', 'editor']),
  ),
  create: access.role(['admin', 'editor', 'member']),
  update: access.any(
    access.owner('author_id'),
    access.role(['admin', 'editor']),
  ),
  delete: access.role(['admin']),
}
```

Generates:

```sql
ALTER TABLE "public"."posts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."posts" FORCE ROW LEVEL SECURITY;

-- SELECT policy
CREATE POLICY "posts_select" ON "public"."posts"
  FOR SELECT USING (
    -- access.custom: raw SQL
    (status = 'published')
    OR
    -- access.owner: compare auth.uid() to field
    (auth.uid() = author_id)
    OR
    -- access.role: check JWT role claim
    (auth.role() = ANY(ARRAY['admin', 'editor']))
  );

-- INSERT policy
CREATE POLICY "posts_insert" ON "public"."posts"
  FOR INSERT WITH CHECK (
    auth.role() = ANY(ARRAY['admin', 'editor', 'member'])
  );

-- UPDATE policy
CREATE POLICY "posts_update" ON "public"."posts"
  FOR UPDATE USING (
    (auth.uid() = author_id)
    OR
    (auth.role() = ANY(ARRAY['admin', 'editor']))
  );

-- DELETE policy
CREATE POLICY "posts_delete" ON "public"."posts"
  FOR DELETE USING (
    auth.role() = 'admin'
  );

-- Service role bypasses RLS (for admin panel, server-side operations)
-- PostgREST connects as 'authenticator' and switches to:
--   'anon' (no JWT) or 'authenticated' (valid JWT)
-- The service_role key connects with a role that bypasses RLS
```

### 13.3 API Key Model

Two keys are generated per project:

1. **anon key** — for client-side use. Encoded JWT with `role: "anon"`. RLS policies apply.
2. **service_role key** — for server-side use only. Encoded JWT with `role: "service_role"`. Bypasses RLS.

Both are JWTs signed with the project's `JWT_SECRET`, so PostgREST can validate them directly.

```typescript
// Client-side (anon key — safe to expose)
const client = createClient({
  url: 'https://myproject.platform.dev',
  anonKey: 'eyJhbGciOiJIUzI1NiIs...',  // public, restricted by RLS
})

// Server-side only (service_role — never expose)
const admin = createClient({
  url: 'https://myproject.platform.dev',
  anonKey: 'eyJhbGciOiJIUzI1NiIs...',   // service_role JWT — bypasses RLS
})
```

---

## 14. Licensing & Distribution

### 14.1 License Structure

| Component | License | Rationale |
|---|---|---|
| `@[platform]/schema` | MIT | Maximum adoption for the type system |
| `@[platform]/client` | MIT | Maximum adoption for the client SDK |
| `@[platform]/react` | MIT | Maximum adoption for React hooks |
| `@[platform]/cli` | MIT | Wrapper is open, engine binary is not |
| Studio (dashboard) | MIT | Maximum adoption, community contributions |
| Admin Panel | MIT | Maximum adoption, community contributions |
| Storage Service | MIT | Consistency across the stack |
| Realtime Service | MIT | Consistency across the stack |
| Docker Compose config | MIT | |
| **Schema Engine binary** | **Proprietary** | **Distributed free, closed source** |
| Cloud control plane | Proprietary | Not distributed |

### 14.2 Engine Distribution Terms

The Schema Engine binary is free to use for any purpose (commercial or non-commercial, self-hosted or cloud). The source code is not available. The binary may not be reverse-engineered, decompiled, or redistributed outside of the official distribution channels.

Enterprise features within the binary are gated behind a license key. Without a key, the engine operates in "community" mode with a model limit.

---

## 15. Build Phases (Granular)

### Phase 0 — Foundations (Weeks 1–4)

**Goal:** Prove the schema engine concept works end-to-end.

- [ ] Set up Rust project structure for the schema engine
- [ ] Implement AST type definitions in Rust (model, field, relation, access)
- [ ] Implement JSON parser (read AST from stdin)
- [ ] Implement basic Postgres introspector (read tables, columns, constraints)
- [ ] Implement basic differ (detect new tables, new columns, dropped columns)
- [ ] Implement basic SQL migration generator (CREATE TABLE, ALTER TABLE ADD/DROP COLUMN)
- [ ] Implement basic TypeScript type generator
- [ ] Set up @[platform]/schema package (TypeScript field/model/relation builders)
- [ ] Implement serialiser (TypeScript runtime objects → JSON AST)
- [ ] Cross-compile engine for macOS (arm64) and Linux (x64)
- [ ] Write integration test: define schema → generate migration → apply → verify DB state

**Deliverable:** A Rust binary that takes a TypeScript schema definition, generates a Postgres migration, and outputs TypeScript types. Tested against a local Postgres instance.

### Phase 1 — Core Schema Engine (Weeks 5–10)

**Goal:** Schema engine handles all common schema operations reliably.

- [ ] Full field type support (all types from Section 3.4)
- [ ] Relation handling: belongsTo (FK generation), hasMany, hasOne, manyToMany (junction table generation)
- [ ] Composite field expansion (timestamps, publishable)
- [ ] Index generation (btree, GIN, GIST for PostGIS, HNSW for pgvector)
- [ ] Constraint generation (CHECK, UNIQUE, NOT NULL)
- [ ] Trigger generation (updated_at auto-update, slug generation)
- [ ] Rename detection (Levenshtein similarity + interactive prompt)
- [ ] Risk analysis (safe/cautious/destructive classification)
- [ ] Rollback migration generation
- [ ] Migration history tracking (_platform_migrations table)
- [ ] Schema state caching (avoid full introspection on every push)
- [ ] Topological sort of operations (dependency ordering)
- [ ] Comprehensive test suite: 50+ test scenarios covering all operation types

**Deliverable:** A robust schema engine that can handle real-world schema definitions and evolution. The engine is the product — everything else is integration.

### Phase 2 — CLI & Local Dev (Weeks 11–16)

**Goal:** Developer can init a project, define a schema, and push to a local Postgres.

- [ ] @[platform]/cli package (TypeScript, wraps engine binary)
- [ ] Binary download on postinstall (platform detection, checksum verification)
- [ ] `init` command (scaffold project, generate .env, docker-compose.yml)
- [ ] `dev` command (start Docker Compose, wait for health checks)
- [ ] `push` command (load schema → serialise → engine parse → diff → migrate → generate)
- [ ] `diff` command (dry run of push)
- [ ] `pull` command (introspect existing DB → generate schema files)
- [ ] `generate` command (regenerate types without migration)
- [ ] `migrate`, `rollback`, `reset` commands
- [ ] `seed` command (run seed file with ts-node/tsx)
- [ ] platform.config.ts configuration loading
- [ ] PostgREST Docker image + auto-configuration
- [ ] pg_graphql extension setup + configuration
- [ ] Verify PostgREST REST endpoints work with generated schema
- [ ] Verify pg_graphql GraphQL endpoint works with generated schema

**Deliverable:** `npx @[platform]/cli init my-project && npx [platform] dev && npx [platform] push` works end-to-end. Developer has a running API.

### Phase 3 — Auth & RLS (Weeks 17–22)

**Goal:** Authentication works, RLS policies are generated from schema.

- [ ] Fork GoTrue (Supabase auth) or integrate existing build
- [ ] Configure GoTrue in Docker Compose
- [ ] Engine: RLS policy generation from access rules
- [ ] Engine: RLS policy diffing (update policies on schema change)
- [ ] Auth helper functions in Postgres (auth.uid(), auth.role(), auth.roles())
- [ ] Role management: default role on signup, role assignment API
- [ ] JWT claims enrichment with app roles
- [ ] Kong configuration: JWT validation middleware
- [ ] @[platform]/client: auth module (signUp, signIn, signOut, onAuthStateChange)
- [ ] @[platform]/react: useAuth hook
- [ ] Integration test: sign up → get JWT → make API request → RLS enforced

**Deliverable:** Full auth flow works. Schema access rules translate to enforced RLS policies.

### Phase 4 — Client SDK & React (Weeks 23–28)

**Goal:** Frontend engineers have a type-safe SDK with React hooks.

- [ ] @[platform]/client: query builder (wraps PostgREST query syntax)
- [ ] @[platform]/client: mutation methods (insert, update, delete, upsert)
- [ ] @[platform]/client: relation embedding (select with nested relations)
- [ ] @[platform]/client: filter operators (eq, neq, gt, lt, like, in, is, etc.)
- [ ] @[platform]/client: pagination (limit, offset, range)
- [ ] @[platform]/client: ordering
- [ ] @[platform]/react: PlatformProvider context
- [ ] @[platform]/react: useQuery hook with caching
- [ ] @[platform]/react: useMutation hook
- [ ] @[platform]/react: useSubscription hook (placeholder — realtime comes later)
- [ ] @[platform]/react-auth: pre-built LoginForm, SignUpForm components
- [ ] Full type inference tests: verify IDE autocomplete works correctly
- [ ] Example Next.js application using the SDK

**Deliverable:** A frontend engineer can npm install the SDK, import generated types, and have full autocomplete and type safety for all CRUD operations.

### Phase 5 — Storage (Weeks 29–33)

**Goal:** File upload/download works, image transforms work.

- [ ] Storage service (Node.js, S3-compatible backend)
- [ ] MinIO in Docker Compose
- [ ] Bucket CRUD API
- [ ] Object upload/download API
- [ ] Image transformation (sharp: resize, format, quality)
- [ ] Auto-bucket creation from schema (image/file fields)
- [ ] Storage RLS (access control on objects table)
- [ ] Pre-signed URL generation
- [ ] @[platform]/client: storage module (upload, download, getPublicUrl, createSignedUrl)
- [ ] Integration with image/file fields: upload via API, store reference in record
- [ ] Kong routing for storage endpoints

**Deliverable:** File upload, download, and image transformation work end-to-end.

### Phase 6 — Admin Panel (Weeks 34–42)

**Goal:** Auto-generated content management UI.

- [ ] Engine: admin configuration JSON generation from schema AST
- [ ] Admin panel React app (Next.js)
- [ ] Dynamic list view renderer (from config)
- [ ] Dynamic edit view renderer (from config)
- [ ] Text input widget
- [ ] Textarea widget (with character counter)
- [ ] Rich text editor widget (Lexical — MIT, Meta-backed, same as Payload CMS)
- [ ] Number input widget
- [ ] Boolean toggle widget
- [ ] Date/time picker widget
- [ ] Select/enum widget
- [ ] Image upload widget (with preview)
- [ ] File upload widget
- [ ] Relation picker widget (search + select)
- [ ] Multi-relation picker widget (tags-style)
- [ ] Publish flow widget (status transitions)
- [ ] JSON editor widget (CodeMirror)
- [ ] List view: search, filter, sort, pagination, bulk actions
- [ ] Edit view: validation, save, delete, duplicate
- [ ] Version history view (diff between versions)
- [ ] Dashboard with configurable widgets (stats, recent items, charts)
- [ ] Navigation from config
- [ ] Branding customisation
- [ ] platform.admin.ts override support

**Deliverable:** Non-technical users can manage content through an auto-generated admin panel.

### Phase 7 — Studio Dashboard (Weeks 43–48)

**Goal:** Developer management UI.

- [ ] Studio React app (Next.js)
- [ ] Visual Schema Designer (basic — field list editor per model)
- [ ] Data Explorer (table browser, record inspector)
- [ ] Raw SQL query runner
- [ ] Migration History viewer (list, detail, rollback button)
- [ ] Auth Management (user list, role assignment)
- [ ] Storage Browser (bucket/file explorer)
- [ ] Auto-generated API documentation (OpenAPI from PostgREST)
- [ ] Request logs viewer
- [ ] Settings (project config, API keys, environment variables)

**Deliverable:** Developer has a web UI for managing all aspects of their project.

### Phase 8 — Realtime (Weeks 49–54)

**Goal:** Live data subscriptions work.

- [ ] Realtime service (Node.js + ws)
- [ ] Postgres logical replication setup (wal2json or pgoutput)
- [ ] Channel subscription management
- [ ] RLS-aware event filtering (only send events user can see)
- [ ] @[platform]/client: realtime module
- [ ] @[platform]/react: useSubscription hook (replace placeholder)
- [ ] Presence support (who's online)
- [ ] Broadcast channels (custom events)
- [ ] Kong WebSocket routing
- [ ] Integration test: insert record → subscriber receives event

**Deliverable:** Client apps can subscribe to data changes in real-time.

### Phase 9 — Cloud MVP (Weeks 55–68)

**Goal:** Public cloud beta launch.

- [ ] Kubernetes cluster setup (Hetzner managed K3s or dedicated servers with k3s)
- [ ] Project provisioner (create DB, deploy pods, configure networking)
- [ ] Free tier: shared Postgres with schema isolation
- [ ] Pro tier: dedicated Postgres provisioning (Neon or RDS)
- [ ] Cloud control plane API
- [ ] Cloud dashboard (web app)
- [ ] Project creation flow
- [ ] API key management
- [ ] Environment management (production, staging, preview)
- [ ] `npx [platform] link` and `npx [platform] deploy` commands
- [ ] Custom domain support (Let's Encrypt SSL)
- [ ] Stripe billing integration
- [ ] Usage metering (API requests, storage, bandwidth)
- [ ] Automated daily backups (Pro+)
- [ ] Monitoring (Prometheus + Grafana)
- [ ] Alerting (PagerDuty or similar)
- [ ] Status page
- [ ] Marketing website
- [ ] Documentation site

**Deliverable:** Cloud beta is live. Developers can sign up, create a project, and deploy.

### Phase 10 — Growth (Ongoing)

- [ ] Edge functions runtime (Deno-based, sandboxed)
- [ ] Schema branching (deferred — revisit when custom pg_dump approach is validated or Hetzner offers branching-compatible Postgres)
- [ ] Template marketplace (pre-built schemas)
- [ ] GraphQL support (alongside REST)
- [ ] Vue hooks package
- [ ] Svelte hooks package
- [ ] React Native SDK
- [ ] Flutter SDK
- [ ] AI features: generate schema from natural language description
- [ ] AI features: vector search integration
- [ ] Plugin system (community extensions)
- [ ] Schema engine WASM build (for browser-based visual designer)
- [ ] Geo field: map picker widget in admin panel
- [ ] Advanced analytics dashboard
- [ ] Team management and RBAC for cloud projects
- [ ] SOC 2 compliance
- [ ] Enterprise sales motion

---

## 16. Open Questions & Decisions Log

### Decided

| Decision | Choice | Rationale |
|---|---|---|
| Schema engine language | Rust | Performance, single binary, future WASM, memory safety |
| Database | PostgreSQL 16 | Maturity, ecosystem, developer trust |
| API layer (REST) | PostgREST | Battle-tested, auto-generates from schema |
| API layer (GraphQL) | pg_graphql (from day 1) | Zero-maintenance, runs inside Postgres, inherits RLS |
| Auth service | GoTrue (Supabase fork, Go) | Proven, feature-complete |
| API gateway | Kong | Proven, declarative config, plugin ecosystem |
| Object storage | MinIO (self-host) / R2 (cloud) | S3-compatible, well-understood |
| Realtime service | Node.js (ws library) | Consistent stack, simpler, sufficient for v1 |
| Edge functions runtime | Deno | Sandboxed, TypeScript-native, same as Supabase |
| Cloud hosting | Hetzner | Cost-efficient, EU data sovereignty / GDPR angle |
| Rich text editor | Lexical (Meta) | MIT, actively developed, Payload uses it |
| Schema approach | Real TypeScript (builder pattern) | IDE support, no custom tooling needed |
| Enum implementation | TEXT + CHECK (not Postgres ENUM) | Easier migration, no ALTER TYPE headaches |
| Free tier model limit | None (gate on infrastructure) | Matches Supabase, avoids artificial limits hurting adoption |
| Free tier infrastructure | Shared Kubernetes | Cost-efficient, schema-level isolation |
| Paid tier infrastructure | Dedicated Postgres | Isolation, performance, trust |
| Pricing model | Hybrid (base monthly + usage overages) | Predictable base, captures value from heavy usage |
| Engine distribution | Precompiled binary (free, closed source) | Protects IP, simple distribution |
| Open source license | MIT (all non-engine components) | Maximum adoption, community contributions |
| Rich text JSON format | Lexical JSON | Modern, extensible, active development |
| `pull` command | Full schema file generation (best-effort) | Enables migration from existing Postgres databases |
| Schema branching | Deferred (not critical for launch) | Neon-native branching incompatible with Hetzner, custom too complex for v1 |
| Self-hosting priority | Secondary (cloud-first) | Focus resources on cloud experience, Docker Compose for self-host |

### Open

| Question | Status | Notes |
|---|---|---|
| Platform name | Exploring compound words | Short, memorable, .com available. Candidates being evaluated. |
