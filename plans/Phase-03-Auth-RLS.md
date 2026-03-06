# Phase 3 — Auth & RLS

> **Supatype** · Weeks 17–22 · March 2026 · Draft

---

## Overview

Add authentication and row-level security. Schema access rules translate directly into enforced Postgres RLS policies. A developer defines who can read, create, update, and delete each model, and the engine generates the corresponding SQL.

## Dependencies

Phase 2 complete — CLI and local dev stack running.

## Deliverable

Full auth flow works end-to-end. Schema access rules translate to enforced RLS policies. Users can sign up, sign in, and make API requests that are automatically scoped by their identity and role.

## Task Breakdown

### Auth

| # | Task | Status |
|---|------|--------|
| 1 | Fork or integrate GoTrue (Supabase auth service) — evaluate maintaining a fork vs using Supabase's published Docker image directly | ○ |
| 2 | Configure GoTrue in Docker Compose — email/password auth, JWT configuration, SMTP for email verification | ○ |
| 3 | Role management — default role assignment on signup, admin API for role assignment, role storage in auth.users or app table | ○ |
| 4 | JWT claims enrichment — include app-specific roles in JWT claims so PostgREST and RLS can read them without extra DB queries | ○ |

### Engine

| # | Task | Status |
|---|------|--------|
| 5 | Engine: RLS policy generation from access rules — convert access.public(), access.authenticated(), access.owner(), access.role(), access.custom() to CREATE POLICY SQL | ○ |
| 6 | Engine: RLS policy diffing — detect when access rules change and regenerate policies without losing data | ○ |

### Database

| # | Task | Status |
|---|------|--------|
| 7 | Auth helper functions in Postgres — auth.uid() extracts user ID from JWT, auth.role() extracts role, auth.roles() returns array of roles from JWT claims | ○ |

### Gateway

| # | Task | Status |
|---|------|--------|
| 8 | Kong configuration — JWT validation middleware on all /rest/v1 and /graphql/v1 routes, pass-through for /auth/v1 | ○ |

### SDK

| # | Task | Status |
|---|------|--------|
| 9 | @supatype/client: auth module — signUp(), signIn(), signOut(), onAuthStateChange(), getSession(), refreshToken() | ○ |
| 10 | @supatype/react: useAuth hook — returns user, session, signIn, signOut, loading state | ○ |

### Testing

| # | Task | Status |
|---|------|--------|
| 11 | Integration test: sign up → get JWT → make API request → verify RLS enforced (can only see own data with access.owner()) | ○ |

## Technical Context

- RLS policies map from schema access rules: access.public() → USING (true), access.authenticated() → USING (auth.uid() IS NOT NULL), access.owner('userId') → USING (user_id = auth.uid()), access.role('admin') → USING (auth.role() = 'admin'), access.custom('...sql...') → USING (custom_expression).
- Each model gets separate policies for SELECT, INSERT, UPDATE, DELETE based on its access.read/create/update/delete rules. ALTER TABLE ... ENABLE ROW LEVEL SECURITY is set on every application table.
- GoTrue handles: email/password registration, email verification, password reset, JWT issuance and refresh, OAuth providers (future). It writes to the auth schema in Postgres.
- Auth helper functions are installed as Postgres functions in a supatype_auth schema, callable from RLS policy expressions.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| GoTrue fork maintenance burden | Start with Supabase's published Docker image; only fork if customisation is essential |
| RLS policy complexity — subtle bugs can expose data | Comprehensive test matrix: test every access rule type × every operation type; include negative tests (verify denied access) |
| JWT claims enrichment adds latency to auth flow | Use Postgres function to enrich claims at token refresh time; cache in JWT with short expiry |

## Success Criteria

Phase 3 is complete when:

- [ ] User can sign up, receive verification email, and sign in
- [ ] JWT contains correct user ID and role claims
- [ ] API requests without JWT are rejected (401)
- [ ] API requests with JWT only return rows matching RLS policies
- [ ] access.owner() correctly scopes queries to the authenticated user's records
- [ ] access.role('admin') grants access only to users with admin role
- [ ] Changing access rules in schema and pushing regenerates RLS policies correctly
