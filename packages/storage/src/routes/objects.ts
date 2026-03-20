import type { RequestContext } from "../server.js"
import { sendJson, readBody, readJson } from "../server.js"
import * as db from "../db.js"
import * as s3 from "../s3.js"
import { parseTransformParams, transformImage } from "../transform.js"
import { config } from "../env.js"
import { validateFileSize, validateContentType, validateStorageQuota } from "../middleware/storage-limits.js"
import { checkReadAccess, checkWriteAccess, checkOverwriteAccess } from "../middleware/access-control.js"
import { createSignedToken, verifySignedToken } from "../middleware/signed-urls.js"
import { applyCorsHeaders } from "../middleware/cors.js"

// ─── Upload ─────────────────────────────────────────────────────────────────────

export async function upload(ctx: RequestContext): Promise<void> {
  const bucketId = ctx.params["bucket"]!
  const objectPath = ctx.params["wildcard"]!

  const bucket = await db.getBucket(bucketId)
  if (!bucket) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }

  // Apply bucket-specific CORS headers
  applyCorsHeaders(ctx.res, bucket)

  // ── Access control (task 44) ────────────────────────────────────────────────
  const writeAccess = checkWriteAccess(bucket, ctx.jwt)
  if (!writeAccess.allowed) {
    sendJson(ctx.res, writeAccess.status, { error: writeAccess.error })
    return
  }

  // ── Content-Type validation (task 43) ───────────────────────────────────────
  const contentType = ctx.req.headers["content-type"] ?? "application/octet-stream"
  const typeError = validateContentType(bucket, contentType)
  if (typeError) {
    sendJson(ctx.res, typeError.status, typeError.body)
    return
  }

  const body = await readBody(ctx.req)

  // ── File size validation (task 41) ──────────────────────────────────────────
  const sizeError = validateFileSize(bucket, body.length)
  if (sizeError) {
    sendJson(ctx.res, sizeError.status, sizeError.body)
    return
  }

  // ── Storage quota check (task 42) ───────────────────────────────────────────
  const quotaError = await validateStorageQuota(body.length)
  if (quotaError) {
    sendJson(ctx.res, quotaError.status, quotaError.body)
    return
  }

  const upsert = ctx.req.headers["x-upsert"] === "true"

  // ── Overwrite permission check for private buckets (task 44) ────────────────
  if (upsert && ctx.jwt) {
    const overwriteAccess = await checkOverwriteAccess(bucket, objectPath, ctx.jwt)
    if (!overwriteAccess.allowed) {
      sendJson(ctx.res, overwriteAccess.status, { error: overwriteAccess.error })
      return
    }
  }

  // Check if object exists (when not upserting)
  if (!upsert) {
    const existing = await db.getObject(bucketId, objectPath)
    if (existing) {
      sendJson(ctx.res, 409, { error: "Object already exists. Use x-upsert: true to overwrite." })
      return
    }
  }

  const owner = ctx.jwt?.sub ?? null

  await s3.putObject(bucketId, objectPath, body, contentType)
  await db.upsertObject(bucketId, objectPath, owner, {
    mimetype: contentType,
    size: body.length,
  })

  sendJson(ctx.res, 200, { Key: `${bucketId}/${objectPath}` })
}

// ─── Download (public bucket) ───────────────────────────────────────────────────

export async function downloadPublic(ctx: RequestContext): Promise<void> {
  const bucketId = ctx.params["bucket"]!
  const objectPath = ctx.params["wildcard"]!

  const bucket = await db.getBucket(bucketId)
  if (!bucket) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }

  // Apply bucket-specific CORS headers (task 46)
  applyCorsHeaders(ctx.res, bucket)

  if (!bucket.public && bucket.access_mode !== "public") {
    sendJson(ctx.res, 403, { error: "Bucket is not public" })
    return
  }

  await serveObject(ctx, bucketId, objectPath)
}

// ─── Download (authenticated) ───────────────────────────────────────────────────

export async function downloadAuthenticated(ctx: RequestContext): Promise<void> {
  const bucketId = ctx.params["bucket"]!
  const objectPath = ctx.params["wildcard"]!

  const bucket = await db.getBucket(bucketId)
  if (!bucket) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }

  // Apply bucket-specific CORS headers (task 46)
  applyCorsHeaders(ctx.res, bucket)

  // ── Access control (task 44) ────────────────────────────────────────────────
  const access = await checkReadAccess(bucket, objectPath, ctx.jwt)
  if (!access.allowed) {
    sendJson(ctx.res, access.status, { error: access.error })
    return
  }

  await serveObject(ctx, bucketId, objectPath)
}

// ─── Download (signed URL) ──────────────────────────────────────────────────────

export async function downloadSigned(ctx: RequestContext): Promise<void> {
  const bucketId = ctx.params["bucket"]!
  const objectPath = ctx.params["wildcard"]!

  const token = ctx.url.searchParams.get("token")
  if (!token) {
    sendJson(ctx.res, 400, { error: "Missing token parameter" })
    return
  }

  const bucket = await db.getBucket(bucketId)
  if (!bucket) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }

  // ── Pre-signed URL verification (task 45) ──────────────────────────────────
  // Try application-level HMAC token first, fall back to S3 pre-signed URL proxy
  const payload = verifySignedToken(token, bucketId, objectPath)
  if (!payload) {
    // The token might be an S3-level pre-signed URL token — check if it looks
    // like a base64url.base64url pair (our format) vs. S3 query params
    if (token.includes(".")) {
      // It was our format but failed verification — reject
      sendJson(ctx.res, 403, { error: "Invalid or expired signed URL" })
      return
    }
    // Otherwise, treat as S3 pre-signed URL and let S3 validate it
  }

  // No CORS for private bucket signed URLs (task 46)
  applyCorsHeaders(ctx.res, bucket)

  await serveObject(ctx, bucketId, objectPath)
}

// ─── Create signed URL ──────────────────────────────────────────────────────────

export async function createSignedUrl(ctx: RequestContext): Promise<void> {
  const bucketId = ctx.params["bucket"]!
  const objectPath = ctx.params["wildcard"]!

  const body = await readJson<{ expiresIn?: number }>(ctx.req)
  const expiresIn = body.expiresIn ?? config.defaultSignedUrlExpiry

  if (expiresIn < 1 || expiresIn > config.maxSignedUrlExpiry) {
    sendJson(ctx.res, 400, {
      error: `expiresIn must be between 1 and ${config.maxSignedUrlExpiry} seconds`,
    })
    return
  }

  const bucket = await db.getBucket(bucketId)
  if (!bucket) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }

  // ── Access control: check read permission before signing (task 44) ──────────
  const access = await checkReadAccess(bucket, objectPath, ctx.jwt)
  if (!access.allowed) {
    sendJson(ctx.res, access.status, { error: access.error })
    return
  }

  // Verify object exists
  const obj = await db.getObject(bucketId, objectPath)
  if (!obj) {
    sendJson(ctx.res, 404, { error: "Object not found" })
    return
  }

  // For private buckets, use our HMAC-signed tokens (task 45)
  // For public buckets, use S3 pre-signed URLs
  const isPrivate = bucket.access_mode === "private" || (!bucket.public && bucket.access_mode !== "public")

  if (isPrivate) {
    // Application-level HMAC-SHA256 signed token
    const token = createSignedToken(bucketId, objectPath, expiresIn)
    const signedUrl = `/object/sign/${bucketId}/${objectPath}?token=${token}`
    sendJson(ctx.res, 200, { signedURL: signedUrl })
  } else {
    // S3-level pre-signed URL
    const signedUrl = await s3.createSignedDownloadUrl(bucketId, objectPath, expiresIn)
    sendJson(ctx.res, 200, { signedURL: signedUrl })
  }
}

// ─── Remove objects ─────────────────────────────────────────────────────────────

export async function removeObjects(ctx: RequestContext): Promise<void> {
  const bucketId = ctx.params["bucket"]!
  const body = await readJson<{ prefixes: string[] }>(ctx.req)

  if (!Array.isArray(body.prefixes) || body.prefixes.length === 0) {
    sendJson(ctx.res, 400, { error: "prefixes array is required" })
    return
  }

  await s3.deleteObjects(bucketId, body.prefixes)
  await db.deleteObjectRows(bucketId, body.prefixes)

  sendJson(ctx.res, 200, body.prefixes.map((name) => ({ name, bucket_id: bucketId })))
}

// ─── List objects ───────────────────────────────────────────────────────────────

export async function listObjects(ctx: RequestContext): Promise<void> {
  const bucketId = ctx.params["bucket"]!
  const body = await readJson<{ prefix?: string; limit?: number; offset?: number }>(ctx.req)

  const rows = await db.listObjectRows(
    bucketId,
    body.prefix ?? "",
    body.limit ?? 100,
    body.offset ?? 0,
  )

  sendJson(ctx.res, 200, rows)
}

// ─── Shared: serve an object with optional transforms ───────────────────────────

async function serveObject(ctx: RequestContext, bucketId: string, objectPath: string): Promise<void> {
  // Touch last_accessed_at
  await db.touchObject(bucketId, objectPath)

  const transformOpts = parseTransformParams(ctx.url.searchParams)

  try {
    const obj = await s3.getObject(bucketId, objectPath)

    if (transformOpts && obj.contentType.startsWith("image/")) {
      // Read entire object for transformation
      const chunks: Uint8Array[] = []
      const reader = obj.body.getReader()
      let done = false
      while (!done) {
        const result = await reader.read()
        if (result.value) chunks.push(result.value)
        done = result.done
      }
      const buffer = Buffer.concat(chunks)

      const transformed = await transformImage(buffer, transformOpts)
      ctx.res.writeHead(200, {
        "Content-Type": transformed.contentType,
        "Content-Length": String(transformed.buffer.length),
        "Cache-Control": `public, max-age=${config.transformCacheTtl}`,
      })
      ctx.res.end(transformed.buffer)
    } else {
      // Stream directly
      ctx.res.writeHead(200, {
        "Content-Type": obj.contentType,
        ...(obj.contentLength > 0 && { "Content-Length": String(obj.contentLength) }),
        "Cache-Control": "public, max-age=3600",
      })
      const reader = obj.body.getReader()
      let done = false
      while (!done) {
        const result = await reader.read()
        if (result.value) ctx.res.write(result.value)
        done = result.done
      }
      ctx.res.end()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("NoSuchKey") || msg.includes("not found") || msg.includes("NotFound")) {
      sendJson(ctx.res, 404, { error: "Object not found" })
    } else {
      throw err
    }
  }
}
