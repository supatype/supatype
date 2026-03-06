# Phase 8 — Realtime

> **Supatype** · Weeks 49–54 · March 2026 · Draft

---

## Overview

Add live data subscriptions via WebSocket. When a record is inserted, updated, or deleted, subscribed clients receive the change in real-time, filtered by RLS policies so users only see changes they're authorised to access.

## Dependencies

Phase 4 complete (useSubscription placeholder), Phase 3 complete (RLS for filtering).

## Deliverable

Client apps can subscribe to data changes in real-time. The useSubscription React hook delivers live updates with the same type safety as queries.

## Task Breakdown

### Service

| # | Task | Status |
|---|------|--------|
| 1 | Realtime service — Node.js application using ws library for WebSocket connections | ○ |
| 2 | Channel subscription management — clients subscribe to table-level or filtered channels | ○ |

### Database

| # | Task | Status |
|---|------|--------|
| 3 | Postgres logical replication setup — configure wal2json or pgoutput for change data capture from WAL | ○ |

### Security

| # | Task | Status |
|---|------|--------|
| 4 | RLS-aware event filtering — before sending an event to a subscriber, verify they can see the record via RLS policy evaluation | ○ |

### SDK

| # | Task | Status |
|---|------|--------|
| 5 | @supatype/client: realtime module — .channel('posts').on('INSERT', callback).subscribe(), .removeChannel() | ○ |

### React

| # | Task | Status |
|---|------|--------|
| 6 | @supatype/react: useSubscription hook — replace Phase 4 placeholder with live implementation | ○ |

### Feature

| # | Task | Status |
|---|------|--------|
| 7 | Presence support — track which users are currently connected, broadcast presence changes | ○ |
| 8 | Broadcast channels — custom events not tied to database changes (e.g., typing indicators, cursor positions) | ○ |

### Gateway

| # | Task | Status |
|---|------|--------|
| 9 | Kong WebSocket routing — /realtime/* route to realtime service with JWT validation on connection | ○ |

### Testing

| # | Task | Status |
|---|------|--------|
| 10 | Integration test: insert record → subscriber receives event with correct payload and type | ○ |

## Technical Context

- The realtime service uses Node.js with the ws library (not Elixir/Phoenix). This was chosen for ecosystem consistency over theoretical scale — Node.js handles the connection counts needed through the Team tier.
- Postgres logical replication streams WAL changes to the realtime service. wal2json formats changes as JSON. The service matches incoming changes against active subscriptions and fans out to connected clients.
- RLS-aware filtering is critical for security. The service must evaluate whether each subscriber can see each changed record before sending it. This is done by running a lightweight query with the subscriber's JWT context.
- WebSocket connections are authenticated via JWT token passed as a query parameter or in the first message after connection.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| RLS-aware filtering performance at scale — evaluating policies per event per subscriber | Cache policy evaluations; batch events; degrade gracefully under load (delay rather than drop) |
| Postgres logical replication slot management — slots that aren't consumed can cause WAL growth | Monitor replication lag; auto-drop stale slots; alert on WAL size thresholds |
| WebSocket connection management — memory per connection, reconnection handling | Use ws library's lightweight per-connection overhead; implement exponential backoff reconnection in client |

## Success Criteria

Phase 8 is complete when:

- [ ] Client receives INSERT/UPDATE/DELETE events within 100ms of database change
- [ ] Events are filtered by RLS — user A cannot see user B's private records
- [ ] Presence shows currently connected users
- [ ] Broadcast channels deliver custom events to all subscribers
- [ ] useSubscription hook updates React component state automatically
- [ ] Reconnection works gracefully after network interruption
