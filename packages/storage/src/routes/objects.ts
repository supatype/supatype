import { randomUUID } from "node:crypto"
import type { RequestContext } from "../server.js"
import { sendJson, readBody, readJson } from "../server.js"
import * as db from "../db.js"
import * as s3 from "../s3.js"
import { parseTransformParams, transformImage } from "../transform.js"
import { config } from "../env.js"
import { validateFileSize, validateContentType, validateStorageQuota } from "../middleware/storage-limits.js"
import { checkReadAccess } from "../middleware/access-control.js"
import type { JwtPayload } from "../auth.js"
import { createSignedToken, verifySignedToken } from "../middleware/signed-urls.js"
import { applyCorsHeaders } from "../middleware/cors.js"

// ─── MIME type inference ─────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".pdf": "application/pdf", ".zip": "application/zip",
  ".json": "application/json", ".xml": "application/xml",
  ".txt": "text/plain", ".csv": "text/csv",
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
}

function inferMime(path: string, headerValue: string): string {
  if (headerValue && headerValue !== "application/octet-stream") return headerValue
  const dot = path.lastIndexOf(".")
  const ext = dot !== -1 ? path.slice(dot).toLowerCase() : ""
  return MIME_MAP[ext] ?? "application/octet-stream"
}

// ─── Upload ─────────────────────────────────────────────────────────────────────

export async function upload(ctx: RequestContext): Promise<void> {
  const bucketId = ctx.params["bucket"]!
  const objectPath = decodeURIComponent(ctx.params["wildcard"]!)

  const bucket = await db.getBucket(bucketId)
  if (!bucket) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }

  // Apply bucket-specific CORS headers
  applyCorsHeaders(ctx.res, bucket)

  const jwt = callerOf(ctx)

  // ── Content-Type validation (task 43) ───────────────────────────────────────
  const contentType = inferMime(objectPath, ctx.req.headers["content-type"] ?? "")
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

  // The bucket's `create` rule decides a new object and its `update` rule an overwrite, both by
  // the database, before any bytes are stored.
  const write: db.ObjectWrite = {
    bucketId,
    name: objectPath,
    metadata: { mimetype: contentType, size: body.length },
  }
  // What the write would be if it were made now: only "written" goes on to store any bytes.
  const wouldBe = await refusingWhenUngranted(ctx, () => db.checkUploadAs(jwt, write, upsert))
  if (wouldBe === undefined) return
  if (wouldBe !== "written") {
    sendWriteOutcome(ctx, jwt, wouldBe, { bucketId, objectPath, upsert })
    return
  }

  const committed = await storeAndCommit(ctx, jwt, write, upsert, { body, contentType })
  if (committed !== undefined) sendWriteOutcome(ctx, jwt, committed.outcome, { bucketId, objectPath, upsert })
}

/**
 * Store the bytes under a fresh version, with no transaction open, then record the row.
 *
 * Nothing the database holds is locked while the bytes travel, so a slow upload does not hold a
 * pooled connection. The bytes being served are never touched: these go alongside them, the row
 * is switched to them on commit, and the replaced version is deleted after. Whatever fails, the
 * bytes just stored are deleted, so a failed upload leaves nothing behind.
 */
async function storeAndCommit(
  ctx: RequestContext,
  jwt: JwtPayload,
  write: db.ObjectWrite,
  upsert: boolean,
  file: { body: Buffer; contentType: string },
): Promise<db.CommittedWrite | undefined> {
  const version = randomUUID()
  const key = s3.objectKey(write.name, version)
  let committed: db.CommittedWrite | undefined
  try {
    await s3.putObject(write.bucketId, key, file.body, file.contentType)
    committed = await refusingWhenUngranted(ctx, () => db.commitUploadAs(jwt, write, upsert, version))
  } catch (err) {
    await discard(write.bucketId, [{ name: write.name, version }])
    throw err
  }
  if (committed?.outcome !== "written") {
    await discard(write.bucketId, [{ name: write.name, version }])
  } else if (committed.replaced !== null) {
    await discard(write.bucketId, [committed.replaced])
  }
  return committed
}

/**
 * Delete stored bytes no row points at any more, best effort.
 *
 * A failure here leaves an orphan in S3 and is logged; it never fails the request, because the
 * request has already happened and nothing reads bytes no row names.
 */
async function discard(bucketId: string, objects: db.StoredObject[]): Promise<void> {
  const keys = objects.map((o) => s3.objectKey(o.name, o.version))
  await s3.deleteObjects(bucketId, keys).catch((err: unknown) => {
    console.error(`[storage] could not delete ${keys.length} stored object(s) in ${bucketId}:`, err)
  })
}

// ─── Caller-scoped writes ───────────────────────────────────────────────────────

/**
 * The caller's JWT. Every route that writes, deletes or lists is registered with `requireAuth`, so
 * the router has already answered 401 for a request without one; reaching here without one is a
 * routing mistake, not a caller's.
 */
function callerOf(ctx: RequestContext): JwtPayload {
  if (!ctx.jwt) throw new Error(`${ctx.req.method} ${ctx.url.pathname} must be registered with requireAuth`)
  return ctx.jwt
}

function sendWriteOutcome(
  ctx: RequestContext,
  jwt: JwtPayload,
  outcome: db.CommittedWrite["outcome"],
  target: { bucketId: string; objectPath: string; upsert: boolean },
): void {
  switch (outcome) {
    case "written":
      sendJson(ctx.res, 200, { Key: `${target.bucketId}/${target.objectPath}` })
      return
    case "exists":
      sendJson(ctx.res, 409, { error: "Object already exists. Use x-upsert: true to overwrite." })
      return
    case "refused":
      refuse(ctx, jwt, target.upsert ? "overwrite this file" : "upload to this bucket")
      return
  }
}

/**
 * Refuse a write the bucket's rule did not allow.
 *
 * 401 for the anon key, which has no user behind it, because signing in is what would change the
 * answer. 403 for a signed-in caller, for whom it would not.
 */
function refuse(ctx: RequestContext, jwt: JwtPayload, action: string): void {
  if (jwt.sub === undefined) {
    sendJson(ctx.res, 401, { error: `Sign in to ${action}` })
  } else {
    sendJson(ctx.res, 403, { error: `You do not have permission to ${action}` })
  }
}

/**
 * Run a caller-scoped database call, answering for a caller the database cannot act as.
 *
 * A database that predates the grants is refused with an explanation in the log, not a 500 naming a
 * Postgres table, because that state is an unfinished upgrade and `supatype push` is the fix. A role
 * the gateway does not issue is refused outright. Returns undefined once it has answered.
 */
async function refusingWhenUngranted<T>(ctx: RequestContext, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof db.MissingGrant) {
      db.reportMissingGrant(err)
      sendJson(ctx.res, 403, { error: "Storage is not configured for this request yet" })
      return undefined
    }
    if (err instanceof db.UnknownRole) {
      sendJson(ctx.res, 403, { error: "You do not have permission to do that" })
      return undefined
    }
    throw err
  }
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
  // Only this service's own HMAC token. Anything else used to be passed through "for S3 to
  // validate", but the object was then fetched with the service's own credentials, so nothing
  // validated it and `?token=x` read any private object with no session at all.
  if (!verifySignedToken(token, bucketId, objectPath)) {
    sendJson(ctx.res, 403, { error: "Invalid or expired signed URL" })
    return
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

  // This service's HMAC token for every bucket (task 45), served through this service, which
  // resolves the object's live version when the URL is used. A public bucket used to get an S3
  // presigned URL to one version's key, which stopped working the moment the object was
  // overwritten and its old version deleted.
  const token = createSignedToken(bucketId, objectPath, expiresIn)
  sendJson(ctx.res, 200, { signedURL: `/object/sign/${bucketId}/${objectPath}?token=${token}` })
}

// ─── Remove objects ─────────────────────────────────────────────────────────────

export async function removeObjects(ctx: RequestContext): Promise<void> {
  const bucketId = ctx.params["bucket"]!
  const body = await readJson<{ prefixes: string[] }>(ctx.req)
  const bucket = await db.getBucket(bucketId)
  if (!bucket) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }

  const jwt = callerOf(ctx)

  if (!Array.isArray(body.prefixes) || body.prefixes.length === 0) {
    sendJson(ctx.res, 400, { error: "prefixes array is required" })
    return
  }

  // The rows first, as the caller, so the bucket's `delete` rule decides; then the bytes, for only
  // the objects Postgres deleted. The response lists those and no others, so an object the caller
  // may not delete is left in place and simply absent from the answer.
  const deleted = await refusingWhenUngranted(ctx, () => db.deleteObjectsAs(jwt, bucketId, body.prefixes))
  if (deleted === undefined) return
  await discard(bucketId, deleted)

  sendJson(ctx.res, 200, deleted.map(({ name }) => ({ name, bucket_id: bucketId })))
}

// ─── List objects ───────────────────────────────────────────────────────────────

export async function listObjects(ctx: RequestContext): Promise<void> {
  const bucketId = ctx.params["bucket"]!
  const body = await readJson<{ prefix?: string; limit?: number; offset?: number }>(ctx.req)
  const bucket = await db.getBucket(bucketId)
  if (!bucket) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }

  const jwt = callerOf(ctx)

  // As the caller, so the list holds only what their read rule allows. It used to run on the
  // service's connection after a check that asked about the prefix as if it were an object, found
  // none, and allowed the call, so any signed-in user listed every name in a private bucket.
  const rows = await refusingWhenUngranted(ctx, () =>
    db.listObjectRowsAs(jwt, bucketId, body.prefix ?? "", {
      limit: body.limit ?? 100,
      offset: body.offset ?? 0,
    }),
  )
  if (rows === undefined) return

  sendJson(ctx.res, 200, rows.map(({ metadata, ...row }) => ({
    ...row,
    size: (metadata as Record<string, unknown> | null)?.["size"] ?? null,
    mimetype: (metadata as Record<string, unknown> | null)?.["mimetype"] ?? null,
    metadata,
  })))
}

// ─── Shared: serve an object with optional transforms ───────────────────────────

/**
 * Does this error mean the object is not there?
 *
 * Read from the error's name and HTTP status, not from its prose. This used to match the *message*
 * against "NoSuchKey", "not found" and "NotFound", and the SDK's message is "The specified key does
 * not exist.", which contains none of them: the name carries `NoSuchKey`. So every request for a
 * missing object in a public bucket answered 500, and a broken image URL looked like a server
 * fault to every cache and CDN in front of it.
 */
function isMissingObject(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const { name } = err as { name?: unknown }
  if (name === "NoSuchKey" || name === "NotFound" || name === "NoSuchBucket") return true
  const { $metadata } = err as { $metadata?: { httpStatusCode?: number } }
  return $metadata?.httpStatusCode === 404
}

async function serveObject(ctx: RequestContext, bucketId: string, objectPath: string): Promise<void> {
  // Touches last_accessed_at, and says which stored version is live. No row is a missing object,
  // which used to be found out only by asking S3 for a key named after the path.
  const stored = await db.touchObject(bucketId, objectPath)
  if (!stored) {
    sendJson(ctx.res, 404, { error: "Object not found" })
    return
  }
  const key = s3.objectKey(stored.name, stored.version)

  const transformOpts = parseTransformParams(ctx.url.searchParams)

  try {
    const obj = await s3.getObject(bucketId, key)

    if (transformOpts && obj.contentType.startsWith("image/")) {
      const transformed = await transformImage(obj.body, transformOpts)
      ctx.res.writeHead(200, {
        "Content-Type": transformed.contentType,
        "Content-Length": String(transformed.buffer.length),
        "Cache-Control": `public, max-age=${config.transformCacheTtl}`,
      })
      ctx.res.end(transformed.buffer)
    } else {
      ctx.res.writeHead(200, {
        "Content-Type": obj.contentType,
        "Content-Length": String(obj.body.length),
        "Cache-Control": "public, max-age=3600",
      })
      ctx.res.end(obj.body)
    }
  } catch (err) {
    if (isMissingObject(err)) {
      sendJson(ctx.res, 404, { error: "Object not found" })
    } else {
      throw err
    }
  }
}
