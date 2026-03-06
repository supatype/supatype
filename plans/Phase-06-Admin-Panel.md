# Phase 6 — Admin Panel

> **Supatype** · Weeks 34–42 · March 2026 · Draft

---

## Overview

Deliver an auto-generated content management UI. The engine reads the schema and generates a configuration JSON that drives a dynamic React admin panel — list views, edit forms, relation pickers, image uploads, rich text editing, and publish workflows.

## Dependencies

Phase 5 complete — storage for image/file uploads.

## Deliverable

Non-technical users can manage content through an auto-generated admin panel that reflects the schema. Developers can customise the panel via supatype.admin.ts overrides.

## Task Breakdown

### Engine

| # | Task | Status |
|---|------|--------|
| 1 | Engine: admin configuration JSON generation from schema AST — field widgets, list columns, filter options, navigation structure | ○ |

### App

| # | Task | Status |
|---|------|--------|
| 2 | Admin panel React app — Next.js application consuming the configuration JSON | ○ |

### Views

| # | Task | Status |
|---|------|--------|
| 3 | Dynamic list view renderer — table from config with columns, data types, formatting | ○ |
| 4 | Dynamic edit view renderer — form from config with field widgets, validation rules | ○ |
| 5 | List view features: search, filter, sort, pagination, bulk actions (delete, publish, archive) | ○ |
| 6 | Edit view features: validation, save, delete, duplicate, unsaved changes warning | ○ |
| 7 | Version history view — diff between record versions (for models with versioning enabled) | ○ |

### Widgets

| # | Task | Status |
|---|------|--------|
| 8 | Text input, textarea (with character counter), number input widgets | ○ |
| 9 | Boolean toggle, date/time picker, select/enum widgets | ○ |
| 10 | Rich text editor widget — Lexical (MIT, Meta-backed, same choice as Payload CMS) | ○ |
| 11 | Image upload widget (with preview, drag-and-drop) and file upload widget | ○ |
| 12 | Relation picker widget (search + select) and multi-relation picker (tags-style) | ○ |
| 13 | Publish flow widget — status transitions (draft → review → published → archived) | ○ |
| 14 | JSON editor widget — CodeMirror with syntax highlighting for jsonb fields | ○ |

### Dashboard

| # | Task | Status |
|---|------|--------|
| 15 | Dashboard — configurable widgets showing stats, recent items, charts | ○ |

### Navigation

| # | Task | Status |
|---|------|--------|
| 16 | Navigation generation from config — sidebar with model groups | ○ |

### Customisation

| # | Task | Status |
|---|------|--------|
| 17 | Branding customisation — logo, colours, favicon via configuration | ○ |
| 18 | supatype.admin.ts override support — custom widgets, field overrides, custom pages, custom actions | ○ |

## Technical Context

- The admin panel is a separate Next.js application served at /admin/* via Kong. It reads configuration JSON from the engine (generated at build time or served from an endpoint).
- Widget selection is automatic based on field type: text → TextInput, richText → Lexical editor, image → ImageUpload with preview, relation → RelationPicker, enum → Select dropdown.
- The rich text editor uses Lexical (Meta's open-source editor framework) — same choice as Payload CMS. MIT licensed, extensible, and actively maintained.
- supatype.admin.ts lets developers override any auto-generated config: hide fields, add custom columns, register custom widgets, add dashboard widgets, define custom bulk actions.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Admin panel scope creep — content management is a deep domain | Ship core CRUD + publish flow first; defer advanced features (workflows, permissions, multi-language) to Phase 10 |
| Lexical editor complexity and bundle size | Lazy-load Lexical only for rich text fields; use minimal plugin set initially |
| Configuration JSON schema — must be stable as it's a public API | Version the config schema; provide migration tooling if schema changes |

## Success Criteria

Phase 6 is complete when:

- [ ] Admin panel renders list and edit views for all models in schema
- [ ] All widget types render correctly and save data
- [ ] Rich text editor saves and loads structured content
- [ ] Image upload works with preview and storage integration
- [ ] Relation picker searches and selects related records
- [ ] Publish flow transitions records between statuses
- [ ] List view supports search, filter, sort, and pagination
- [ ] supatype.admin.ts overrides are applied correctly
