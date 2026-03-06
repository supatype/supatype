# Phase 9 — Cloud MVP

> **Supatype** · Weeks 55–68 · March 2026 · Draft

---

## Overview

Launch the public cloud beta. Developers can sign up, create a project, and deploy their Supatype application to managed infrastructure on Hetzner. Billing, monitoring, and basic operations are functional.

## Dependencies

Phases 0–8 complete — all platform features working locally.

## Deliverable

Cloud beta is live. Developers can sign up, create a project, push their schema, and have a production-ready backend running on managed infrastructure.

## Task Breakdown

### Infra

| # | Task | Status |
|---|------|--------|
| 1 | Kubernetes cluster setup — Hetzner dedicated servers with k3s, EU data centres (Falkenstein, Nuremberg, Helsinki) | ○ |
| 2 | Project provisioner — create isolated DB (shared Postgres schema for Free, dedicated for Pro+), deploy service pods, configure networking and DNS | ○ |

### Tiers

| # | Task | Status |
|---|------|--------|
| 3 | Free tier implementation — shared Postgres with schema isolation, 500MB DB, 1GB storage, 5GB bandwidth, 2 projects, pause after 7 days inactivity | ○ |
| 4 | Pro tier implementation — dedicated Postgres, 8GB DB, 50GB storage, 50GB bandwidth, daily backups | ○ |

### API

| # | Task | Status |
|---|------|--------|
| 5 | Cloud control plane API — project CRUD, environment management, deployment triggers, API key management | ○ |

### Dashboard

| # | Task | Status |
|---|------|--------|
| 6 | Cloud dashboard web app — project creation flow, environment overview, usage graphs, settings | ○ |
| 7 | Project creation flow — sign up → choose tier → name project → provision → connect | ○ |

### Security

| # | Task | Status |
|---|------|--------|
| 8 | API key management — create/revoke anon and service_role keys per environment | ○ |

### Environments

| # | Task | Status |
|---|------|--------|
| 9 | Environment management — production, staging, preview environments with separate databases | ○ |

### CLI

| # | Task | Status |
|---|------|--------|
| 10 | `npx supatype link` and `npx supatype deploy` commands — connect local project to cloud, push schema to remote | ○ |

### Networking

| # | Task | Status |
|---|------|--------|
| 11 | Custom domain support — Let's Encrypt SSL provisioning via cert-manager | ○ |

### Billing

| # | Task | Status |
|---|------|--------|
| 12 | Stripe billing integration — subscription management, plan changes, invoicing | ○ |
| 13 | Usage metering — track API requests, storage bytes, bandwidth, MAU for overage billing | ○ |

### Operations

| # | Task | Status |
|---|------|--------|
| 14 | Automated daily backups for Pro+ tiers — pg_dump to object storage with retention | ○ |
| 15 | Monitoring — Prometheus metrics collection, Grafana dashboards for system and per-project health | ○ |
| 16 | Alerting — PagerDuty or Opsgenie integration for critical issues | ○ |
| 17 | Status page — public page showing system health and incident history | ○ |

### Marketing

| # | Task | Status |
|---|------|--------|
| 18 | Marketing website — landing page, pricing, docs links, sign-up CTA | ○ |

### Docs

| # | Task | Status |
|---|------|--------|
| 19 | Documentation site — getting started, CLI reference, SDK reference, schema reference, deployment guides | ○ |

## Technical Context

- Hetzner was chosen for cost efficiency and EU data sovereignty/GDPR positioning. Trade-off: fewer global regions than AWS (US expansion requires a second provider later).
- Free tier uses shared Postgres with per-project schema isolation (each project gets its own Postgres schema within a shared instance). Pro+ tiers get dedicated Postgres instances.
- Pricing: Free £0 (500MB DB, 1GB storage, 5GB bandwidth), Pro £25/mo (8GB DB, 50GB storage), Team £75/mo (50GB DB, 500GB storage, 99.9% SLA), Enterprise custom.
- Overage pricing: £0.125/GB DB, £0.02/GB storage, £0.09/GB bandwidth, £0.00325/MAU, £2/M edge invocations.
- The control plane is a separate application (not part of the open-source platform) — it manages provisioning, billing, monitoring, and multi-tenancy.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Multi-tenant security — shared Postgres schema isolation must be bulletproof | Extensive penetration testing; separate Postgres roles per project; network isolation between pods |
| Hetzner infrastructure limitations vs AWS (no managed Kubernetes, fewer regions) | Use k3s (lightweight Kubernetes); plan US region expansion for Phase 10; accept EU-only for beta |
| Billing complexity — usage metering accuracy, proration, failed payments | Use Stripe's built-in metering and billing features; start with simple monthly billing; add usage billing incrementally |
| Cloud operations burden — on-call, incident response, customer support | Automate heavily; set up comprehensive monitoring before beta launch; limit beta to 100 projects initially |

## Success Criteria

Phase 9 is complete when:

- [ ] Developer can sign up and create a project in under 2 minutes
- [ ] Project provisioning completes in under 60 seconds
- [ ] `npx supatype deploy` pushes schema to cloud successfully
- [ ] Free tier enforces resource limits correctly
- [ ] Stripe billing charges correctly for Pro tier
- [ ] Custom domains work with automatic SSL
- [ ] Monitoring detects and alerts on service failures
- [ ] Documentation covers getting started through deployment
