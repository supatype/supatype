# Phase 10 — Growth

> **Definatype** · Weeks Ongoing · March 2026 · Draft

---

## Overview

Expand the platform's capabilities, ecosystem, and market reach. This phase is continuous — features are prioritised based on user demand, competitive landscape, and strategic value.

## Dependencies

Phase 9 complete — cloud platform live and stable.

## Deliverable

A continuously evolving platform with edge functions, additional framework support, AI features, a plugin ecosystem, and enterprise capabilities.

## Task Breakdown

### Runtime

| # | Task | Status |
|---|------|--------|
| 1 | Edge functions runtime — Deno-based sandboxed execution environment for custom server-side logic | ○ |

### Engine

| # | Task | Status |
|---|------|--------|
| 2 | Schema branching — deferred from earlier phases; revisit when Hetzner-compatible approach is validated | ○ |
| 3 | Schema engine WASM build — run the engine in the browser for the visual schema designer | ○ |

### Ecosystem

| # | Task | Status |
|---|------|--------|
| 4 | Template marketplace — pre-built schemas (blog, e-commerce, SaaS, CMS) that developers can clone and customise | ○ |
| 5 | Plugin system — community extensions for custom field types, widgets, auth providers, storage backends | ○ |

### API

| # | Task | Status |
|---|------|--------|
| 6 | GraphQL enhancements — subscriptions via pg_graphql, custom resolvers, schema stitching | ○ |

### SDK

| # | Task | Status |
|---|------|--------|
| 7 | Vue hooks package — @definatype/vue with composables matching the React hook API | ○ |
| 8 | Svelte hooks package — @definatype/svelte with stores matching the React hook API | ○ |
| 9 | React Native SDK — @definatype/react-native with mobile-optimised auth flows and offline support | ○ |
| 10 | Flutter SDK — @definatype/flutter with Dart client matching the TypeScript SDK API | ○ |

### AI

| # | Task | Status |
|---|------|--------|
| 11 | AI: generate schema from natural language description — describe your app, get a schema | ○ |
| 12 | AI: vector search integration — embedding generation, similarity queries, RAG support | ○ |

### Admin

| # | Task | Status |
|---|------|--------|
| 13 | Geo field: map picker widget in admin panel — visual location selection for PostGIS fields | ○ |

### Cloud

| # | Task | Status |
|---|------|--------|
| 14 | Advanced analytics dashboard — query performance, usage trends, cost optimisation suggestions | ○ |
| 15 | Team management and RBAC for cloud projects — invite team members, assign roles (admin, developer, viewer) | ○ |

### Enterprise

| # | Task | Status |
|---|------|--------|
| 16 | SOC 2 compliance — security audit, policies, procedures for enterprise customers | ○ |
| 17 | Enterprise sales motion — custom pricing, dedicated support, SLA negotiations, on-premise deployment | ○ |

## Technical Context

- Edge functions use Deno's isolate model for sandboxed execution — each function runs in its own V8 isolate with configurable memory and CPU limits. TypeScript-native, same as Supabase Edge Functions.
- The WASM build of the schema engine enables a fully browser-based visual schema designer that can parse, validate, and diff schemas without a server round-trip.
- The plugin system should be npm-based — developers publish @definatype/plugin-* packages that register custom field types, admin widgets, or auth providers. The engine and admin panel discover plugins from definatype.config.ts.
- AI schema generation uses an LLM to convert natural language descriptions into Definatype schema TypeScript code. This is a developer convenience, not a core feature.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Feature sprawl — too many SDKs to maintain | Prioritise by user demand; consider community-maintained SDKs for less popular frameworks |
| Edge functions security — sandboxing must prevent resource abuse and data leakage | Use Deno's permission model; enforce strict memory/CPU/time limits; no network access to internal services by default |
| Enterprise sales requires different skills than developer tools | Hire enterprise sales person when Team tier revenue justifies; start with inbound enterprise leads only |

## Success Criteria

Phase 10 is complete when:

- [ ] Edge functions deploy and execute within 50ms cold start
- [ ] At least 10 community templates in marketplace
- [ ] Vue and Svelte SDKs pass the same test suite as React
- [ ] AI schema generation produces valid, deployable schemas
- [ ] Plugin system supports at least 3 community plugins
- [ ] SOC 2 Type II report achieved
- [ ] Enterprise tier has at least 3 paying customers
