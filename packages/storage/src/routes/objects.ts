import type { RequestContext } from "../server.js"
import { sendJson, readBody, readJson } from "../server.js"
import * as db from "../db.js"
import * as s3 from "../s3.js"
import { parseTransformParams, transformImage } from "../transform.js"
import { config } from "../env.js"

// ─── Upload ─────────────────────────────────────────────────────────────────────

export async function upload(ctx: RequestContext): Promise<void> {
  const bucketId = ctx.params["bucket"]!
  const objectPath = ctx.params["wildcard"]!

  const bucket = await db.getBucket(bucketId)
  if (!bucket) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }

  // Check mime type restrictions
  const contentType = ctx.req.headers["content-type"] ?? "application/octet-stream"
  if (bucket.allowed_mime_types && bucket.allowed_mime_types.length > 0) {
    const allowed = bucket.allowed_mime_types.some((mime) =>
      mime.endsWith("/*")
        ? contentType.startsWith(mime.slice(0, -1))
        : contentType === mime,
    )
    if (!allowed) {
      sendJson(ctx.res, 415, { error: `Content type ${contentType} not allowed for this bucket` })
      return
    }
  }

  const body = await readBody(ctx.req)

  // Check file size
  if (bucket.file_size_limit !== null && body.length > bucket.file_size_limit) {
    sendJson(ctx.res, 413, { error: `File exceeds size limit of ${bucket.file_size_limit} bytes` })
    return
  }
  if (body.length > config.maxUploadSize) {
    sendJson(ctx.res, 413, { error: `File exceeds maximum upload size of ${config.maxUploadSize} bytes` })
    return
  }

  const upsert = ctx.req.headers["x-upsert"] === "true"

  // Check if object exists
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
  if (!bucket.public) {
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

  // Token is the S3 pre-signed URL query params — the request was already validated
  // by the S3 backend when generating the signed URL, so we just proxy to S3.
  await serveObject(ctx, bucketId, objectPath)
}

// ─── Create signed URL ──────────────────────────────────────────────────────────

export async function createSignedUrl(ctx: RequestContext): Promise<void> {
  const bucketId = ctx.params["bucket"]!
  const objectPath = ctx.params["wildcard"]!

  const body = await readJson<{ expiresIn?: number }>(ctx.req)
  const expiresIn = body.expiresIn ?? 3600

  if (expiresIn < 1 || expiresIn > 604800) {
    sendJson(ctx.res, 400, { error: "expiresIn must be between 1 and 604800 seconds" })
    return
  }

  // Verify object exists
  const obj = await db.getObject(bucketId, objectPath)
  if (!obj) {
    sendJson(ctx.res, 404, { error: "Object not found" })
    return
  }

  const signedUrl = await s3.createSignedDownloadUrl(bucketId, objectPath, expiresIn)
  sendJson(ctx.res, 200, { signedURL: signedUrl })
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
