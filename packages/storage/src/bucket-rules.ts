/**
 * What a bucket may be, refused with 400 before anything is stored.
 *
 * The id rules are the server's built-in store's (internal/objstore, cleanBucketID and
 * refuseBucketID): an id that could not be a directory of its own, a separator, `.` or `..`, and
 * the store's own `.supatype` in any case, which an import from that store must never turn into a
 * bucket. The length cap and the settings checks are this service's: a size limit is a whole number
 * of bytes the bigint column can hold, a MIME type is `type/subtype` (or `type/*`), and a policy is
 * a JSON object, so a value that cannot be honoured is refused rather than stored or answered 500.
 */
import { isJsonObject } from "./json.js"

/** The longest bucket id, as S3 allows a bucket name. */
const MAX_BUCKET_ID = 63

/** The server's store keeps its own bookkeeping in a directory of this name, so it is never a bucket. */
const STORE_META_DIR = ".supatype"

/** A MIME type a bucket can accept: `type/subtype` in RFC 6838's restricted names, or `type/*`. */
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,126})$/i

/** Why `id` cannot be a bucket, or null when it can. */
export function bucketIdProblem(id: string): string | null {
  const unusable =
    id === "" ||
    id !== id.trim() ||
    id.length > MAX_BUCKET_ID ||
    /[/\\]/.test(id) ||
    id === "." ||
    id === ".." ||
    id.toLowerCase() === STORE_META_DIR
  return unusable ? `invalid bucket id: ${JSON.stringify(id)}` : null
}

/** The settings a create or an update may name. */
export interface BucketSettings {
  file_size_limit?: number | null | undefined
  allowed_mime_types?: readonly string[] | null | undefined
  s3_bucket_policy?: string | null | undefined
}

/** Why these settings cannot be stored, or null when they can. Absent and null are fine. */
export function bucketSettingsProblem(settings: BucketSettings): string | null {
  const limit = settings.file_size_limit
  if (limit != null && (!Number.isSafeInteger(limit) || limit < 0)) {
    return `file_size_limit must be a whole number of bytes from 0 to ${Number.MAX_SAFE_INTEGER}, got ${limit}`
  }
  const badType = settings.allowed_mime_types?.find((type) => !MIME_TYPE.test(type))
  if (badType !== undefined) return `allowed_mime_types holds ${JSON.stringify(badType)}, which is not a MIME type`
  const policy = settings.s3_bucket_policy
  if (policy != null && policy !== "" && !isJsonObjectText(policy)) return "s3_bucket_policy must be a JSON object"
  return null
}

/** Every field a bucket create or update reads. */
const BUCKET_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "public",
  "file_size_limit",
  "allowed_mime_types",
  "access_mode",
  "s3_bucket_policy",
])

/**
 * Fields Supabase's storage client sends for features this service does not have, each taken at the
 * values that ask for none of the feature, and refused at any other with why. Its createBucket sends
 * `type` ("STANDARD", or "ANALYTICS" for an Iceberg bucket) and both send `versioning_status`.
 */
const CLIENT_FIELDS: Readonly<Record<string, { takes: readonly unknown[]; why: string }>> = {
  type: { takes: [null, "STANDARD"], why: "this service stores STANDARD buckets" },
  versioning_status: { takes: [null], why: "this service keeps no object versions" },
}

/**
 * Why `body` cannot be a bucket write: it names a field the service does not read, which used to be
 * ignored, so `policy` meant for `s3_bucket_policy` made a bucket without one, or asks a feature of
 * {@link CLIENT_FIELDS} the service does not have. Null when it does neither.
 */
export function bucketFieldsProblem(body: object): string | null {
  const fields = Object.entries(body)
  const unknown = fields.filter(([key]) => !BUCKET_FIELDS.has(key) && !Object.hasOwn(CLIENT_FIELDS, key))
  if (unknown.length > 0) return `unknown field(s): ${unknown.map(([key]) => key).join(", ")}`
  for (const [key, value] of fields) {
    const field = Object.hasOwn(CLIENT_FIELDS, key) ? CLIENT_FIELDS[key] : undefined
    if (field !== undefined && !field.takes.includes(value)) return `${key} ${JSON.stringify(value)} is not supported: ${field.why}`
  }
  return null
}

/**
 * Why an update naming `id` or `name` cannot be applied to `bucket`, or null. `id` must be the
 * bucket's. `name` may be its name or its id: Supabase's storage client sends the id as the name,
 * and a bucket created with a name of its own still takes that update.
 */
export function renameProblem(
  bucket: { id: string; name: string },
  body: { id?: string | undefined; name?: string | undefined },
): string | null {
  if (body.id !== undefined && body.id !== bucket.id) {
    return `a bucket cannot be renamed: id ${JSON.stringify(body.id)} is not ${JSON.stringify(bucket.id)}`
  }
  if (body.name !== undefined && body.name !== bucket.name && body.name !== bucket.id) {
    return `a bucket cannot be renamed: name ${JSON.stringify(body.name)} is not ${JSON.stringify(bucket.name)}`
  }
  return null
}

function isJsonObjectText(text: string): boolean {
  try {
    return isJsonObject(JSON.parse(text))
  } catch {
    return false
  }
}
