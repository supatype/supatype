import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteBucketPolicyCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { config } from "./env.js"
import { bucketNameRuleBroken } from "./s3-settings.js"

const settings = config.s3

// No endpoint for AWS, where the region names it, and no keys for the SDK's own credential chain.
const clientConfig = {
  region: settings.region,
  forcePathStyle: settings.forcePathStyle,
  ...(settings.endpoint !== undefined && { endpoint: settings.endpoint }),
  ...(settings.credentials !== undefined && { credentials: settings.credentials }),
}

/** Whether every Supatype bucket is a prefix in the one S3 bucket `S3_BUCKET` names. */
const oneBucket = settings.bucket !== ""

/** The S3 bucket a Supatype bucket's objects are in: the one S3 bucket, or its own, prefixed. */
function s3BucketOf(bucket: string): string {
  return oneBucket ? settings.bucket : `${settings.bucketPrefix}${bucket}`
}

/**
 * Where a Supatype bucket's object is in S3: key `key` in the bucket's own S3 bucket, or
 * `<bucket>/<key>` in the one S3 bucket. A bucket id never holds a `/` (bucket-rules.ts), so no
 * bucket's prefix starts another's.
 */
function at(bucket: string, key: string): { Bucket: string; Key: string } {
  return { Bucket: s3BucketOf(bucket), Key: oneBucket ? `${bucket}/${key}` : key }
}

/**
 * Why Supatype bucket `id` cannot have an S3 bucket of its own, or null when it can. Checked when
 * the name is one AWS judges: with a prefix, or on AWS itself. A store at an endpoint with no prefix
 * keeps taking what it took before, since a self-host SeaweedFS already holds buckets by those names.
 */
export function s3BucketNameProblem(id: string): string | null {
  if (oneBucket || (settings.bucketPrefix === "" && settings.endpoint !== undefined)) return null
  const name = s3BucketOf(id)
  const broken = bucketNameRuleBroken(name)
  return broken === null ? null : `bucket id "${id}" makes the S3 bucket name "${name}", and an S3 bucket name needs ${broken}`
}

export const s3 = new S3Client(clientConfig)

/**
 * The client that signs upload URLs, and the only difference is that it computes no checksum.
 *
 * A presigned `PutObject` is signed from a command with **no body**, so the default setting
 * (`WHEN_SUPPORTED`) hashes nothing and writes the result into the URL as
 * `x-amz-checksum-crc32=AAAAAA==`, the CRC32 of zero bytes. The client then uploads real bytes
 * against a URL that promises empty ones. A backend that checks rejects it, correctly, and one that
 * ignores a checksum in the query string accepts it: MinIO ignored it, SeaweedFS refused with
 * `BadDigest`, so every upload URL we have ever minted was wrong and only the backend hid it.
 *
 * Scoped to presigning rather than set on the shared client above, because `WHEN_REQUIRED` would
 * also drop the checksum from ordinary `putObject` calls, where it is computed over the real body
 * and is worth keeping.
 */
const presigner = new S3Client({ ...clientConfig, requestChecksumCalculation: "WHEN_REQUIRED" })

// ─── Bucket operations ─────────────────────────────────────────────────────────

/** An S3 bucket for the Supatype bucket; nothing in one S3 bucket, where a prefix needs no making. */
export async function ensureBucket(name: string): Promise<void> {
  if (oneBucket) return
  const Bucket = s3BucketOf(name)
  try {
    await s3.send(new HeadBucketCommand({ Bucket }))
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket }))
  }
}

/**
 * Deletes the Supatype bucket's S3 bucket, or in one S3 bucket every key under its prefix. The
 * service deletes only a bucket with no objects left, so a key still there is bytes nothing points
 * at (an upload whose row never committed), and a bucket made later with the same id must not
 * inherit them.
 */
export async function deleteBucket(name: string): Promise<void> {
  if (!oneBucket) {
    await s3.send(new DeleteBucketCommand({ Bucket: s3BucketOf(name) }))
    return
  }
  await deleteKeys(settings.bucket, await keysUnder(`${name}/`))
}

/** Every key under `prefix` in the one S3 bucket, as S3 names them, a page at a time. */
async function keysUnder(prefix: string): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: settings.bucket, Prefix: prefix, ...(token !== undefined && { ContinuationToken: token }) }),
    )
    for (const o of res.Contents ?? []) if (o.Key !== undefined) keys.push(o.Key)
    token = res.IsTruncated === true ? res.NextContinuationToken : undefined
  } while (token !== undefined)
  return keys
}

/**
 * Lets a bucket policy open the S3 bucket to the public: AWS refuses a public policy until
 * BlockPublicPolicy and RestrictPublicBuckets are off. Stores without the call are fine to ignore.
 */
async function allowPublicPolicy(Bucket: string): Promise<void> {
  try {
    await s3.send(new PutPublicAccessBlockCommand({
      Bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        IgnorePublicAcls: false,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      },
    }))
  } catch { /* not supported by all S3-compatible backends, safe to ignore */ }
}

/** Apply a caller-supplied bucket policy document (must be valid IAM JSON) to the bucket's S3 bucket. */
export async function applyRawBucketPolicy(name: string, policyJson: string): Promise<void> {
  const Bucket = s3BucketOf(name)
  await allowPublicPolicy(Bucket)
  await s3.send(new PutBucketPolicyCommand({ Bucket, Policy: policyJson }))
}

/**
 * Apply a public-read bucket policy so objects are directly accessible at the object store's URL
 * without going through the storage proxy. Called when a bucket is created or updated public.
 */
export async function applyPublicPolicy(name: string): Promise<void> {
  const Bucket = s3BucketOf(name)
  await allowPublicPolicy(Bucket)
  await s3.send(new PutBucketPolicyCommand({
    Bucket,
    Policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Sid: "PublicReadGetObject",
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${Bucket}/*`,
      }],
    }),
  }))
}

/** Errors that mean there is no policy to remove: none was put, or the backend has no policies. */
const NOTHING_TO_REMOVE = new Set(["NoSuchBucketPolicy", "NotImplemented", "MethodNotAllowed"])

/**
 * Removes the bucket's policy. It could only ever be put, so a bucket made private kept the
 * public-read policy and stayed readable by anyone straight from S3. A bucket with no policy has
 * nothing to remove, and a backend without bucket policies could never have put one.
 */
async function removeBucketPolicy(name: string): Promise<void> {
  try {
    await s3.send(new DeleteBucketPolicyCommand({ Bucket: s3BucketOf(name) }))
  } catch (err: unknown) {
    if (!(err instanceof Error && NOTHING_TO_REMOVE.has(err.name))) throw err
  }
}

/**
 * Choose S3 policy application: custom JSON wins, else public-read when `public`, else none.
 *
 * Nothing in one S3 bucket: a policy there would be the whole bucket's, every Supatype bucket's at
 * once, so a public bucket is served by this service alone (the routes refuse a custom policy).
 */
export async function applyBucketPolicyFromConfig(
  name: string,
  opts: { public: boolean; s3BucketPolicy?: string | null },
): Promise<void> {
  if (oneBucket) return
  const raw = opts.s3BucketPolicy
  if (raw !== undefined && raw !== null && raw.trim() !== "") {
    await applyRawBucketPolicy(name, raw)
    return
  }
  if (opts.public) await applyPublicPolicy(name)
  else await removeBucketPolicy(name)
}

/**
 * Whether every Supatype bucket shares the one S3 bucket `S3_BUCKET` names. A bucket's S3 policy
 * would then be that S3 bucket's, every Supatype bucket's at once, so none can be set.
 */
export function singleBucketMode(): boolean {
  return oneBucket
}

// ─── Object operations ─────────────────────────────────────────────────────────

export async function putObject(
  bucket: string,
  key: string,
  body: Buffer | ReadableStream | Uint8Array,
  contentType: string,
): Promise<void> {
  await s3.send(new PutObjectCommand({ ...at(bucket, key), Body: body, ContentType: contentType }))
}

export async function getObject(
  bucket: string,
  key: string,
): Promise<{ body: Buffer; contentType: string; contentLength: number }> {
  const res = await s3.send(new GetObjectCommand(at(bucket, key)))
  const body = Buffer.from(await res.Body!.transformToByteArray())
  return {
    body,
    contentType: res.ContentType ?? "application/octet-stream",
    contentLength: body.length,
  }
}

export async function headObject(
  bucket: string,
  key: string,
): Promise<{ contentType: string; contentLength: number; lastModified: Date | undefined }> {
  const res = await s3.send(new HeadObjectCommand(at(bucket, key)))
  return {
    contentType: res.ContentType ?? "application/octet-stream",
    contentLength: res.ContentLength ?? 0,
    lastModified: res.LastModified,
  }
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand(at(bucket, key)))
}

export async function deleteObjects(bucket: string, keys: string[]): Promise<void> {
  await deleteKeys(s3BucketOf(bucket), keys.map((key) => at(bucket, key).Key))
}

/** Deletes `keys` from the S3 bucket `bucket`, as S3 names them. */
async function deleteKeys(bucket: string, keys: string[]): Promise<void> {
  // S3 takes at most 1000 keys per request, and emptying a bucket can pass any number.
  for (let from = 0; from < keys.length; from += DELETE_BATCH) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.slice(from, from + DELETE_BATCH).map((Key) => ({ Key })) },
      }),
    )
  }
}

const DELETE_BATCH = 1000

/** Keys under `prefix` in the Supatype bucket, named within it whichever mode stores them. */
export async function listObjects(
  bucket: string,
  prefix: string,
  limit: number,
  offset: number,
): Promise<{ key: string; size: number; lastModified: Date | undefined }[]> {
  const where = at(bucket, prefix)
  const res = await s3.send(
    new ListObjectsV2Command({
      Bucket: where.Bucket,
      Prefix: where.Key || undefined,
      MaxKeys: limit + offset,
    }),
  )
  const strip = where.Key.length - prefix.length
  const items = (res.Contents ?? []).slice(offset)
  return items.map((o) => ({
    key: (o.Key ?? "").slice(strip),
    size: o.Size ?? 0,
    lastModified: o.LastModified,
  }))
}

// ─── Pre-signed URLs ────────────────────────────────────────────────────────────

export async function createSignedDownloadUrl(
  bucket: string,
  key: string,
  expiresIn: number,
): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand(at(bucket, key)), { expiresIn })
}

export async function createSignedUploadUrl(
  bucket: string,
  key: string,
  expiresIn: number,
  contentType?: string,
): Promise<string> {
  return getSignedUrl(
    presigner,
    new PutObjectCommand({
      ...at(bucket, key),
      ...(contentType !== undefined && { ContentType: contentType }),
    }),
    { expiresIn },
  )
}
