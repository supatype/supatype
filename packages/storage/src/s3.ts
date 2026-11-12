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
  S3ServiceException,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { createHash } from "node:crypto"
import { bucketIdProblem } from "./bucket-rules.js"
import { config } from "./env.js"
import { isStepPart } from "./object-names.js"
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

/** The folder every key is under in the one S3 bucket: `S3_KEY_PREFIX` and a `/`, or "" for none. */
const keyRoot = settings.keyPrefix === "" ? "" : `${settings.keyPrefix}/`

/** The start of every key a Supatype bucket's objects have in the one S3 bucket. */
function bucketRoot(bucket: string): string {
  return `${keyRoot}${bucket}/`
}

/**
 * Refuses a key that could land outside the Supatype bucket's own folder, and so outside this
 * deployment's. The routes already refuse such names (object-names.ts, bucket-rules.ts); this is the
 * last check before S3, so a route that misses one still cannot reach another project's files.
 *
 * The bucket id must pass the same rule a create does (bucket-rules.ts), and in a shared S3 bucket
 * be plain characters too. The key may be "" (a whole bucket's listing) or end in one "/" (a
 * folder's), and every other part must be a name: never empty, "." or "..".
 */
function assertInsideBucket(bucket: string, key: string): void {
  const parts = (key.endsWith("/") ? key.slice(0, -1) : key).split("/")
  const keyOk = key === "" || !parts.some(isStepPart)
  const bucketOk = bucketIdProblem(bucket) === null && (keyRoot === "" || sharedFolderNameProblem(bucket) === null)
  if (!bucketOk || !keyOk) {
    throw new Error(`Refusing S3 key ${JSON.stringify(key)} in bucket ${JSON.stringify(bucket)}: it is outside the bucket's folder`)
  }
}

/**
 * Where a Supatype bucket's object is in S3: key `key` in the bucket's own S3 bucket, or
 * `[<S3_KEY_PREFIX>/]<bucket>/<key>` in the one S3 bucket. A bucket id never holds a `/`
 * (bucket-rules.ts), so no bucket's prefix starts another's. The only place a key is built.
 */
function at(bucket: string, key: string): { Bucket: string; Key: string } {
  assertInsideBucket(bucket, key)
  return { Bucket: s3BucketOf(bucket), Key: oneBucket ? `${bucketRoot(bucket)}${key}` : key }
}

/** A bucket id that is one plain folder name: letters, digits, `.`, `_` and `-`, no `%` or space. */
const PLAIN_BUCKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

/**
 * Why bucket `id` cannot be a folder beside other deployments' in a shared S3 bucket, or null. With
 * `S3_KEY_PREFIX` set, other projects' files are in the same S3 bucket, so a bucket id is held to
 * plain characters: nothing a store or proxy on the way could read as a separator or an escape.
 */
function sharedFolderNameProblem(id: string): string | null {
  // Starting with a letter or digit already rules out "." and "..".
  if (PLAIN_BUCKET_ID.test(id)) return null
  return `bucket id ${JSON.stringify(id)} must be letters, digits, ".", "_" and "-", starting with a letter or digit`
}

/**
 * Why Supatype bucket `id` cannot have an S3 bucket of its own, or null when it can. Checked when
 * the name is one AWS judges: with a prefix, or on AWS itself. A store at an endpoint with no prefix
 * keeps taking what it took before, since a self-host SeaweedFS already holds buckets by those names.
 */
export function s3BucketNameProblem(id: string): string | null {
  if (keyRoot !== "") return sharedFolderNameProblem(id)
  if (oneBucket || (settings.bucketPrefix === "" && settings.endpoint !== undefined)) return null
  const name = s3BucketOf(id)
  const broken = bucketNameRuleBroken(name)
  return broken === null ? null : `bucket id "${id}" makes the S3 bucket name "${name}", and an S3 bucket name needs ${broken}`
}

export const s3 = new S3Client(clientConfig)

/** A request whose body the SDK serialized itself: an XML or JSON document, never an upload's bytes. */
function hasSerializedBody(request: unknown): request is { body: string; headers: Record<string, string> } {
  if (typeof request !== "object" || request === null) return false
  if (!("body" in request) || typeof request.body !== "string" || request.body === "") return false
  return "headers" in request && typeof request.headers === "object" && request.headers !== null
}

/**
 * Sends Content-MD5 with every request whose body the SDK wrote, alongside its own checksum.
 *
 * 0.9.2 release test (N-FF10). S3 requires a checksum on DeleteObjects, a bucket policy and the other
 * control documents, and for years that checksum was Content-MD5. Since 3.729 the SDK sends a CRC32
 * instead and computes no MD5 at all, even with `requestChecksumCalculation: "WHEN_REQUIRED"`, which
 * only stops the optional ones. Older S3-compatible stores (MinIO RELEASE.2024-11-07 among them)
 * refuse such a request with `MissingContentMD5`, so every remove answered 200 and left the bytes.
 *
 * Only a body the SDK serialized: those are small documents, and every request S3 wants a checksum
 * on is one. An upload's bytes keep the SDK's own CRC32 and are not hashed a second time. AWS and
 * newer stores take both headers and check both.
 */
function sendContentMd5(client: S3Client): void {
  client.middlewareStack.add(
    (next) => async (args) => {
      const { request } = args
      if (hasSerializedBody(request) && request.headers["content-md5"] === undefined) {
        request.headers["content-md5"] = createHash("md5").update(request.body).digest("base64")
      }
      return next(args)
    },
    // In the build step, where the SDK adds its own checksum, before the request is signed.
    { name: "supatypeContentMd5", step: "build", priority: "low" },
  )
}

sendContentMd5(s3)
tagUnreachableStore(s3)

/** An S3 request that never reached the store: refused, no such host, no route (see {@link storeUnreachable}). */
export class StoreUnreachable extends Error {
  constructor(readonly code: string, cause: unknown) {
    super(`The S3 store at ${storeName()} cannot be reached (${code}): check that it is running and that the storage service can reach it`, { cause })
  }
}

/**
 * Turns Node's error for a connection the store never took into a {@link StoreUnreachable}, on the
 * client's own requests only: the database client passes the same codes through, and a Postgres
 * that is down must not be reported as the S3 store. Outermost, so after the SDK's own retries.
 */
function tagUnreachableStore(client: S3Client): void {
  client.middlewareStack.add(
    (next) => async (args) => {
      try {
        return await next(args)
      } catch (err) {
        const code = err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined
        throw code !== undefined && UNREACHABLE_CODES.has(code) ? new StoreUnreachable(code, err) : err
      }
    },
    { name: "supatypeStoreUnreachable", step: "initialize", priority: "high" },
  )
}

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
  assertInsideBucket(name, "")
  await deleteKeys(settings.bucket, await keysUnder(bucketRoot(name)))
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

/** How long the start-time bucket check waits for the store before starting anyway. */
const BUCKET_CHECK_TIMEOUT_MS = 3_000

/** The client the start-time bucket check asks with: one attempt, no retries. */
const bucketChecker = new S3Client({ ...clientConfig, maxAttempts: 1 })

/** Where the S3 store is, as an error message names it. */
function storeName(): string {
  return settings.endpoint ?? `AWS S3 in ${settings.region}`
}

/** Node's codes for a connection to the store that was never made: refused, no such host, no route. */
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"])

/**
 * What to tell the caller when err is the S3 store not being reachable at all, else undefined.
 *
 * 0.9.2 release test round 2 (R2-S4): a store down at start let the service start, as
 * {@link checkOneBucket} means it to, but the first upload then answered a bare 500 and the
 * ECONNREFUSED was only in the log. The SDK passes Node's own connection error through, code and all.
 */
export function storeUnreachable(err: unknown): string | undefined {
  return err instanceof StoreUnreachable ? err.message : undefined
}

/**
 * Refuses to start on an `S3_BUCKET` the store does not have, or will not let these keys reach.
 *
 * 0.9.2 release test (N-S23): a wrong name started cleanly and every upload answered 500. HeadBucket
 * needs only `s3:ListBucket`, which the keys need anyway. A store that does not answer is not a
 * reason to refuse: it may still be starting, and the first request that needs it says so then.
 *
 * Asked once, and given up on after {@link BUCKET_CHECK_TIMEOUT_MS}: the SDK sets no timeout and
 * retries, so an endpoint that accepted the connection and never answered held the start forever.
 */
export async function checkOneBucket(): Promise<void> {
  if (!oneBucket) return
  const named = `S3_BUCKET is "${settings.bucket}", and ${storeName()}`
  try {
    await bucketChecker.send(new HeadBucketCommand({ Bucket: settings.bucket }), {
      abortSignal: AbortSignal.timeout(BUCKET_CHECK_TIMEOUT_MS),
    })
  } catch (err: unknown) {
    const status = err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined
    if (status === 404) throw new Error(`${named} has no bucket by that name: create it, or name one it has`)
    if (status === 403) {
      throw new Error(
        `${named} refuses these keys access to that bucket (403): check the name, and that the keys have s3:ListBucket on it`,
      )
    }
    const why = err instanceof Error ? err.message : String(err)
    console.warn(`supatype-storage could not check S3_BUCKET "${settings.bucket}" at ${storeName()}, starting anyway: ${why}`)
  }
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
