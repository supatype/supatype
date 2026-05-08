# Runtime Contract

This document defines behavior that must stay consistent across all Supatype runtime lanes:

- Dev (binary/process manager)
- Self-host (Docker Compose)
- Cloud (Kubernetes)

## API Surface Invariants

All lanes must expose the same route families:

- `/rest/v1/`
- `/auth/v1/`
- `/storage/v1/`
- `/realtime/v1/`
- `/functions/v1/`
- `/` (app entrypoint behavior from `app.mode`)

## Auth Invariants

- JWT role semantics for `anon`, `authenticated`, and `service_role` must match.
- Auth-related routes and headers (`apikey`, bearer tokens) must be interpreted consistently.
- Service role behavior must bypass row-level constraints consistently where intended.

## App Serving Invariants

`app.mode` in `supatype.config.ts` is the source of truth:

- `none`: `/` is not served by an app runtime.
- `static`: static assets are served from configured output.
- `proxy`: requests are proxied to `app.upstream`.

No lane is allowed to introduce behavior outside this contract.

## Operational Invariants

- Health checks must exist for core services.
- Startup ordering must enforce database readiness before dependents.
- Logs and status output should expose equivalent service-level health.

## Anti-Drift Rules

- Route definitions are derived from a shared route spec in CLI source.
- Self-host compose artifacts are generated deterministically from config.
- Contract tests validate route mapping, auth wiring, and app-mode behavior in CI.
