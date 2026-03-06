# Phase 5 — Storage

> **Supatype** · Weeks 29–33 · March 2026 · Draft

---

## Overview

Add file upload, download, and image transformation. Image and file fields in the schema automatically create storage buckets with appropriate access controls.

## Dependencies

Phase 4 complete — client SDK working.

## Deliverable

File upload, download, and image transformation work end-to-end. Storage integrates with schema fields — uploading an image to a record stores the reference automatically.

## Task Breakdown

### Service

| # | Task | Status |
|---|------|--------|
| 1 | Storage service — Node.js HTTP server with S3-compatible backend abstraction (MinIO for local, S3/R2 for cloud) | ○ |

### Infra

| # | Task | Status |
|---|------|--------|
| 2 | MinIO in Docker Compose — S3-compatible object storage for local development | ○ |

### API

| # | Task | Status |
|---|------|--------|
| 3 | Bucket CRUD API — create, list, delete buckets with public/private visibility settings | ○ |
| 4 | Object upload/download API — multipart upload, streaming download, content-type detection | ○ |
| 5 | Pre-signed URL generation — time-limited URLs for private file access | ○ |

### Transform

| # | Task | Status |
|---|------|--------|
| 6 | Image transformation — sharp integration for resize, crop, format conversion (webp, avif), quality adjustment, delivered via URL parameters | ○ |

### Engine

| # | Task | Status |
|---|------|--------|
| 7 | Auto-bucket creation from schema — image() and file() field types trigger bucket creation with naming convention (model_field) | ○ |

### Security

| # | Task | Status |
|---|------|--------|
| 8 | Storage RLS — access control on storage.objects table, inheriting model-level access rules or custom per-bucket policies | ○ |

### SDK

| # | Task | Status |
|---|------|--------|
| 9 | @supatype/client: storage module — .storage.from('bucket').upload(file), .download(path), .getPublicUrl(path), .createSignedUrl(path, expiresIn) | ○ |

### Integration

| # | Task | Status |
|---|------|--------|
| 10 | Integration with image/file fields — upload via API stores reference in record, retrieve returns URL | ○ |

### Gateway

| # | Task | Status |
|---|------|--------|
| 11 | Kong routing — /storage/v1/* routes to storage service with JWT validation | ○ |

## Technical Context

- The storage service is a standalone Node.js application (not part of PostgREST). It manages its own tables in the storage schema (buckets, objects) and uses S3 API for actual file operations.
- Image transformations are applied on-the-fly via URL parameters: /storage/v1/object/public/avatars/user.jpg?width=200&height=200&format=webp. Transformed images are cached.
- Storage RLS works by storing object metadata in Postgres (storage.objects table) with RLS policies. The storage service checks permissions before serving files.
- MinIO provides S3-compatible API locally, making the storage service cloud-agnostic. In production, it connects to real S3, Cloudflare R2, or Hetzner Object Storage.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Image transformation performance under load | Cache transformed images in storage backend; use sharp's streaming API for memory efficiency |
| Large file upload reliability (timeouts, partial uploads) | Implement resumable uploads with tus protocol for files > 50MB |
| Storage RLS complexity — bucket policies vs model policies | Start with simple model-level inheritance; add custom bucket policies as escape hatch |

## Success Criteria

Phase 5 is complete when:

- [ ] File upload and download works via the client SDK
- [ ] Image transformation returns resized/reformatted images via URL parameters
- [ ] Auto-created buckets appear when schema has image/file fields
- [ ] Private bucket files require valid JWT to access
- [ ] Pre-signed URLs work with configurable expiry
- [ ] Storage integrates with CRUD — uploading to a record's image field stores the reference
