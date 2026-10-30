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
} from "../object-store.js"

import type { BucketAccessMode } from "../db.js"
import { accessModeOf, nextAccessMode } from "../bucket-access.js"
import { bucketIdProblem, bucketSettingsProblem, renameProblem, bucketFieldsProblem } from "../bucket-rules.js"

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

/** `id` and `name` may only name the bucket itself: a Supabase client's update sends them along. */
const isUpdateBucketBody = isShape({
  id: optional(isString),
  name: optional(isString),
  public: optional(isBoolean),
  file_size_limit: optional(nullable(isNumber)),
  allowed_mime_types: optional(nullable(isArrayOf(isString))),
  access_mode: optional(isAccessMode),
  s3_bucket_policy: optional(nullable(isString)),
})

/** Answers 400 with `problem` and says so, or does nothing when there is none. */
function refused(ctx: RequestContext, problem: string | null): boolean {
  if (problem === null) return false
  sendJson(ctx.res, 400, { error: problem })
  return true
}

type CreateBucketBody = typeof isCreateBucketBody extends (value: unknown) => value is infer T ? T : never
type UpdateBucketBody = typeof isUpdateBucketBody extends (value: unknown) => value is infer T ? T : never

/**
 * The bucket's row, then its S3 policy. Only once the row exists: a name already taken answers 409
 * before the policy of the bucket holding it is touched. Public on S3 exactly when the mode says
 * so, since a custom bucket's rules decide who reads it, and a new private bucket has no policy.
 */
async function createBucketAndPolicy(id: string, body: CreateBucketBody & { name: string }): Promise<db.BucketRow> {
  const accessMode: BucketAccessMode = body.access_mode ?? (body.public ? "public" : "private")
  await ensureS3Bucket(id)
  const bucket = await db.createBucket(id, body.name, accessMode, body.file_size_limit, body.allowed_mime_types, body.s3_bucket_policy)
  if (accessMode === "public" || bucket.s3_bucket_policy) {
    await applyBucketPolicyFromConfig(id, { public: accessMode === "public", s3BucketPolicy: bucket.s3_bucket_policy })
  }
  return bucket
}

export async function create(ctx: RequestContext): Promise<void> {
  const body = await readJson(ctx.req, isCreateBucketBody)
  if (refused(ctx, bucketFieldsProblem(body))) return

  if (!body.name) {
    sendJson(ctx.res, 400, { error: "name is required" })
    return
  }

  const id = body.id ?? body.name
  if (refused(ctx, bucketIdProblem(id) ?? bucketSettingsProblem(body))) return
  try {
    const bucket = await createBucketAndPolicy(id, { ...body, name: body.name })
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
  if (refused(ctx, bucketFieldsProblem(body) ?? bucketSettingsProblem(body))) return
  const id = ctx.params["id"]!
  const existing = await db.getBucket(id)
  if (existing && refused(ctx, renameProblem(existing, body))) return
  if (!existing || !(await applyUpdate(id, existing, body))) {
    sendJson(ctx.res, 404, { error: "Bucket not found" })
    return
  }
  sendJson(ctx.res, 200, { message: "Successfully updated" })
}

/**
 * Writes `body` over the bucket's row, then its S3 policy; false when the row is gone by then.
 * A public flag moves the mode, which decides every read; setting the flag alone left it where it
 * was. A row whose stored pair is not yet the mode's is written as well, NULL mode included.
 */
async function applyUpdate(id: string, existing: db.BucketRow, body: UpdateBucketBody): Promise<boolean> {
  const accessMode = nextAccessMode(accessModeOf(existing), body)
  const isPublic = accessMode === "public"
  const accessChanged = accessMode !== existing.access_mode || isPublic !== existing.public
  const namesAccess =
    body.public !== undefined || body.access_mode !== undefined || body.s3_bucket_policy !== undefined
  const bucket = await db.updateBucket(id, {
    ...(body.file_size_limit !== undefined && { file_size_limit: body.file_size_limit }),
    ...(body.allowed_mime_types !== undefined && { allowed_mime_types: body.allowed_mime_types }),
    ...(body.s3_bucket_policy !== undefined && { s3_bucket_policy: body.s3_bucket_policy }),
    ...(accessChanged && { access_mode: accessMode }),
  })
  if (!bucket) return false
  // S3 follows the row once it is written, so a bucket deleted in between is not opened on S3.
  // A write that names access applies it even when the row already holds it: that is a retry of a
  // write whose S3 step failed, and the row alone would never send it again.
  if (accessChanged || namesAccess) {
    await applyBucketPolicyFromConfig(id, { public: isPublic, s3BucketPolicy: bucket.s3_bucket_policy })
  }
  return true
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
