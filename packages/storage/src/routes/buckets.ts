import type { RequestContext } from "../server.js"
import { sendJson, readJson } from "../server.js"
import * as db from "../db.js"
import { isArrayOf, isBoolean, isNumber, isOneOf, isShape, isString, nullable, optional } from "../json.js"
import {
  ensureBucket as ensureS3Bucket,
  deleteBucket as deleteS3Bucket,
  deleteObjects as deleteS3Objects,
  applyBucketPolicyFromConfig,
  objectKey,
} from "../s3.js"

import type { BucketAccessMode } from "../db.js"
import { accessModeOf, nextAccessMode } from "../bucket-access.js"

const isAccessMode = isOneOf(["public", "private", "custom"] as const satisfies readonly BucketAccessMode[])

/** `name` is checked by the handler, which answers a missing one by name. */
const isCreateBucketBody = isShape({
  id: optional(isString),
  name: optional(isString),
  public: optional(isBoolean),
  file_size_limit: optional(isNumber),
  allowed_mime_types: optional(isArrayOf(isString)),
  access_mode: optional(isAccessMode),
  s3_bucket_policy: optional(nullable(isString)),
})

const isUpdateBucketBody = isShape({
  public: optional(isBoolean),
  file_size_limit: optional(nullable(isNumber)),
  allowed_mime_types: optional(nullable(isArrayOf(isString))),
  access_mode: optional(isAccessMode),
  s3_bucket_policy: optional(nullable(isString)),
})

export async function create(ctx: RequestContext): Promise<void> {
  const body = await readJson(ctx.req, isCreateBucketBody)

  if (!body.name) {
    sendJson(ctx.res, 400, { error: "name is required" })
    return
  }

  const id = body.id ?? body.name
  const accessMode = accessModeOf({ access_mode: body.access_mode ?? null, public: body.public ?? false })
  // Public on S3 exactly when the mode says so: a custom bucket's rules decide who reads it.
  const isPublic = accessMode === "public"
  try {
    await ensureS3Bucket(id)
    await applyBucketPolicyFromConfig(id, {
      public: isPublic,
      ...(body.s3_bucket_policy !== undefined && { s3BucketPolicy: body.s3_bucket_policy }),
    })
    const bucket = await db.createBucket(
      id,
      body.name,
      isPublic,
      body.file_size_limit,
      body.allowed_mime_types,
      accessMode,
      body.s3_bucket_policy,
    )
    sendJson(ctx.res, 200, { name: bucket.name })
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create bucket"
    if (msg.includes("duplicate key") || msg.includes("already exists")) {
      sendJson(ctx.res, 409, { error: `Bucket ${body.name} already exists` })
    } else {
      sendJson(ctx.res, 500, { error: msg })
    }
  }
}

export async function list(ctx: RequestContext): Promise<void> {
  const buckets = await db.listBuckets()
  sendJson(ctx.res, 200, buckets)
}

export async function get(ctx: RequestContext): Promise<void> {
  const bucket = await db.getBucket(ctx.params["id"]!)
  if (!bucket) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }
  sendJson(ctx.res, 200, bucket)
}

export async function update(ctx: RequestContext): Promise<void> {
  const body = await readJson(ctx.req, isUpdateBucketBody)
  const id = ctx.params["id"]!
  const existing = await db.getBucket(id)
  if (!existing) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }
  // The flag and the mode change together, as on create. A flag set alone left the mode, which
  // decides every read, where it was.
  const accessMode = nextAccessMode(accessModeOf(existing), body)
  const isPublic = accessMode === "public"
  const changesAccess = body.public !== undefined || body.access_mode !== undefined
  if (changesAccess || body.s3_bucket_policy !== undefined) {
    const nextPolicy =
      body.s3_bucket_policy !== undefined ? body.s3_bucket_policy : existing.s3_bucket_policy
    await applyBucketPolicyFromConfig(id, { public: isPublic, s3BucketPolicy: nextPolicy })
  }
  const updates = changesAccess ? { ...body, access_mode: accessMode, public: isPublic } : body
  const bucket = await db.updateBucket(id, updates)
  if (!bucket) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }
  sendJson(ctx.res, 200, { message: "Successfully updated" })
}

export async function remove(ctx: RequestContext): Promise<void> {
  const id = ctx.params["id"]!
  // Must be empty first
  if (await db.bucketHasObjects(id)) {
    sendJson(ctx.res, 400, { error: "Bucket not empty. Call /bucket/:id/empty first." })
    return
  }

  try {
    await deleteS3Bucket(id)
  } catch {
    // S3 bucket may already be deleted
  }
  const deleted = await db.deleteBucketRow(id)
  if (!deleted) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }
  sendJson(ctx.res, 200, { message: "Successfully deleted" })
}

export async function empty(ctx: RequestContext): Promise<void> {
  const id = ctx.params["id"]!
  const bucket = await db.getBucket(id)
  if (!bucket) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }
  await db.emptyBucket(id, (objects) =>
    deleteS3Objects(
      id,
      objects.map((o) => objectKey(o.name, o.version)),
    ),
  )
  sendJson(ctx.res, 200, { message: "Successfully emptied" })
}
