# Phase 4 — Client SDK & React

> **Supatype** · Weeks 23–28 · March 2026 · Draft

---

## Overview

Build the type-safe client SDK and React hooks that frontend engineers will use daily. The SDK wraps PostgREST's query syntax with TypeScript generics so every query, mutation, and filter is fully typed from the generated schema.

## Dependencies

Phase 3 complete — auth and RLS working.

## Deliverable

A frontend engineer can npm install the SDK, import generated types, and have full IDE autocomplete and type safety for all CRUD operations, including relation embedding and filtering.

## Task Breakdown

### SDK

| # | Task | Status |
|---|------|--------|
| 1 | @supatype/client: query builder — .from('posts').select('id, title, author(name)') wrapping PostgREST query syntax with TypeScript generics | ○ |
| 2 | @supatype/client: mutation methods — .from('posts').insert({...}), .update({...}).eq('id', x), .delete().eq('id', x), .upsert({...}) | ○ |
| 3 | @supatype/client: relation embedding — .select('*, comments(*, author(*))') with typed nested responses | ○ |
| 4 | @supatype/client: filter operators — .eq(), .neq(), .gt(), .lt(), .gte(), .lte(), .like(), .ilike(), .in(), .is(), .contains(), .overlaps() | ○ |
| 5 | @supatype/client: pagination — .range(0, 9), .limit(10), .offset(20), response headers for total count | ○ |
| 6 | @supatype/client: ordering — .order('created_at', { ascending: false }), multi-column ordering | ○ |

### React

| # | Task | Status |
|---|------|--------|
| 7 | @supatype/react: SupatypeProvider context — initialises client, provides to component tree | ○ |
| 8 | @supatype/react: useQuery hook — fetches data with caching, returns { data, error, loading, refetch } | ○ |
| 9 | @supatype/react: useMutation hook — returns { mutate, data, error, loading } with optimistic updates | ○ |
| 10 | @supatype/react: useSubscription hook — placeholder for realtime (Phase 8), returns stale data with flag | ○ |
| 11 | @supatype/react-auth: pre-built LoginForm and SignUpForm components with sensible defaults and customisation props | ○ |

### Testing

| # | Task | Status |
|---|------|--------|
| 12 | Full type inference tests: verify IDE autocomplete works correctly for all query patterns | ○ |

### Example

| # | Task | Status |
|---|------|--------|
| 13 | Example Next.js application: blog with auth, CRUD, image uploads (storage placeholder), demonstrating the full SDK | ○ |

## Technical Context

- The SDK is modelled on Supabase's client but with stronger typing. Generated types from the engine feed into the client generics so .from('posts') knows the Post type and all its fields.
- The query builder doesn't execute queries — it builds a PostgREST URL. The client sends HTTP requests to the Kong gateway which routes to PostgREST.
- Relation embedding uses PostgREST's resource embedding syntax (?select=*,comments(*)) which uses FK relationships to join data.
- The React hooks use a simple cache layer (not a full state manager) — SWR-style stale-while-revalidate pattern. No dependency on React Query or SWR libraries.
- GraphQL is also available via @supatype/client: .graphql() method that sends queries to the pg_graphql endpoint.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| TypeScript generic complexity — inference chains can break or produce 'any' | Write inference tests that assert specific types; test with multiple TypeScript versions (5.3, 5.4, 5.5) |
| PostgREST query syntax limitations vs developer expectations | Document limitations clearly; provide .rpc() method for custom Postgres functions as escape hatch |
| React hook API design — hard to change after adoption | Study Supabase, React Query, SWR, and Convex hook APIs; user test with 3-5 frontend developers before finalising |

## Success Criteria

Phase 4 is complete when:

- [ ] IDE autocomplete works for table names, column names, and filter values
- [ ] Nested relation queries return correctly typed responses
- [ ] All filter operators produce correct PostgREST query parameters
- [ ] useQuery hook caches responses and refetches on window focus
- [ ] useMutation hook handles optimistic updates and error rollback
- [ ] LoginForm and SignUpForm render and complete auth flows
- [ ] Example Next.js app demonstrates full CRUD with auth
