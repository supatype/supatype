import type { RequestContext } from "../server.js"
import { sendJson, readJson } from "../server.js"
import * as db from "../db.js"
import { ensureBucket as ensureS3Bucket, deleteBucket as deleteS3Bucket } from "../s3.js"

import type { BucketAccessMode } from "../db.js"

interface CreateBucketBody {
  id?: string
  name: string
  public?: boolean
  file_size_limit?: number
  allowed_mime_types?: string[]
  access_mode?: BucketAccessMode
}

interface UpdateBucketBody {
  public?: boolean
  file_size_limit?: number | null
  allowed_mime_types?: string[] | null
  access_mode?: BucketAccessMode
}

export async function create(ctx: RequestContext): Promise<void> {
  const body = await readJson<CreateBucketBody>(ctx.req)

  if (!body.name) {
    sendJson(ctx.res, 400, { error: "name is required" })
    return
  }

  const id = body.id ?? body.name
  try {
    await ensureS3Bucket(id)
    const bucket = await db.createBucket(
      id,
      body.name,
      body.public ?? false,
      body.file_size_limit,
      body.allowed_mime_types,
      body.access_mode,
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
  const body = await readJson<UpdateBucketBody>(ctx.req)
  const bucket = await db.updateBucket(ctx.params["id"]!, body)
  if (!bucket) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }
  sendJson(ctx.res, 200, { message: "Successfully updated" })
}

export async function remove(ctx: RequestContext): Promise<void> {
  const id = ctx.params["id"]!
  // Must be empty first
  const objects = await db.listObjectRows(id, "", 1, 0)
  if (objects.length > 0) {
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
  await db.emptyBucket(id)
  sendJson(ctx.res, 200, { message: "Successfully emptied" })
}
