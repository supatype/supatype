/**
 * How the service reaches S3, in one of two modes.
 *
 * **One S3 bucket** (`S3_BUCKET` set): every Supatype bucket is a key prefix inside that bucket, as
 * Supabase Storage keeps them under `GLOBAL_S3_BUCKET`. The login needs only to read, write, list and
 * delete in that one bucket.
 *
 * **An S3 bucket per Supatype bucket** (`S3_BUCKET` unset): each Supatype bucket is an S3 bucket of
 * its own, named `S3_BUCKET_PREFIX` then the bucket's id, created on demand with its own policy. The
 * prefix (empty unless set) keeps the names apart from every other account's on AWS.
 *
 * Either mode reaches AWS by region (no endpoint) or any S3-compatible store by endpoint, with keys
 * or with the AWS SDK's own credentials. Nothing has a default that points somewhere: per-bucket mode
 * used to fall back to localhost:8333 and the login published in this repository whenever a setting
 * was missing, until 0.9.2. The self-host stack passes every setting for its SeaweedFS
 * explicitly, so it needs none of them, and a setting the service cannot work without fails at start.
 */

/** Access keys for S3; absent means the AWS SDK's default chain finds them. */
export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
}

export interface S3Settings {
  /** The S3 bucket every Supatype bucket is a prefix in, or "" for an S3 bucket per Supatype bucket. */
  bucket: string
  /** Put in front of a Supatype bucket's id to name its S3 bucket, in per-bucket mode; "" for none. */
  bucketPrefix: string
  /** The S3-compatible store's URL; undefined for AWS, where the region names it. */
  endpoint: string | undefined
  region: string
  /** undefined: the AWS SDK's default chain (AWS_* variables, a profile, an instance or task role). */
  credentials: S3Credentials | undefined
  forcePathStyle: boolean
  /** Base URL of a public bucket's objects straight from S3, which only per-bucket mode has. */
  publicUrl: string
}

/** A setting, with a blank one read as unset: init writes `S3_ENDPOINT=` and the like into .env. */
function setting(key: string): string | undefined {
  const value = process.env[key]?.trim()
  return value === undefined || value === "" ? undefined : value
}

/** Both keys, or neither for the SDK's chain; one alone is a mistake, refused rather than half used. */
function credentials(): S3Credentials | undefined {
  const accessKeyId = setting("S3_ACCESS_KEY")
  const secretAccessKey = setting("S3_SECRET_KEY")
  if (accessKeyId !== undefined && secretAccessKey !== undefined) return { accessKeyId, secretAccessKey }
  if (accessKeyId === undefined && secretAccessKey === undefined) return undefined
  throw new Error(
    "S3_ACCESS_KEY and S3_SECRET_KEY go together: set both, or neither for the AWS SDK's own " +
      `credentials (an instance or task role, AWS_* variables, a profile). Only ${accessKeyId === undefined ? "S3_SECRET_KEY" : "S3_ACCESS_KEY"} is set`,
  )
}

/** What an S3 bucket name may hold, from AWS's rules: lowercase letters, digits, `.` and `-`. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
/** The start of a prefix: what a bucket name may begin with, the rest of the name to follow. */
const PREFIX = /^[a-z0-9][a-z0-9.-]{0,59}$/

/**
 * Which of AWS's bucket naming rules `name` breaks, or null when it keeps them all; the strictest
 * stores share them. An IP address, `..`, and the prefixes and suffixes AWS keeps for itself are out.
 */
export function bucketNameRuleBroken(name: string): string | null {
  if (name.length < 3 || name.length > 63) return "3 to 63 characters"
  if (!BUCKET_NAME.test(name)) return "lowercase letters, digits, dots and hyphens, starting and ending with a letter or digit"
  if (name.includes("..")) return "no two dots in a row"
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return "not an IP address"
  if (/^(xn--|sthree-|amzn-s3-demo-)/.test(name) || /(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(name)) {
    return "none of the prefixes and suffixes AWS reserves"
  }
  return null
}

/** `S3_BUCKET_PREFIX`, refused beside `S3_BUCKET` or when no bucket name could start with it. */
function bucketPrefix(bucket: string | undefined): string {
  const prefix = setting("S3_BUCKET_PREFIX") ?? ""
  if (prefix === "") return ""
  if (bucket !== undefined) {
    throw new Error(
      `S3_BUCKET_PREFIX names the S3 bucket each Supatype bucket gets, and with S3_BUCKET set there is one bucket, ${bucket}. ` +
        "Unset one of them",
    )
  }
  if (!PREFIX.test(prefix)) {
    throw new Error(
      `S3_BUCKET_PREFIX is "${prefix}", and an S3 bucket name starts with a lowercase letter or digit and holds only ` +
        "lowercase letters, digits, dots and hyphens, 63 characters at most",
    )
  }
  return prefix
}

/** The settings S3 is reached with, in either mode. */
function s3Store(bucket: string | undefined): S3Settings {
  const endpoint = setting("S3_ENDPOINT")
  // A store at an endpoint takes any region, and most expect us-east-1. AWS needs the real one.
  const region = setting("S3_REGION") ?? (endpoint === undefined ? undefined : "us-east-1")
  if (region === undefined) {
    throw new Error(
      "The storage service has nowhere to keep files: set S3_REGION for AWS S3, " +
        "or S3_ENDPOINT for an S3-compatible store such as MinIO or Cloudflare R2",
    )
  }
  const pathStyle = setting("S3_FORCE_PATH_STYLE")
  return {
    bucket: bucket ?? "",
    bucketPrefix: bucketPrefix(bucket),
    endpoint,
    region,
    credentials: credentials(),
    // AWS addresses a bucket by host name; most stores at an endpoint by path.
    forcePathStyle: pathStyle === undefined ? endpoint !== undefined : pathStyle === "true",
    publicUrl: setting("S3_PUBLIC_URL") ?? endpoint ?? "",
  }
}

/** For the file backend, which never talks to S3: a client that is never used needs no settings. */
const UNUSED: S3Settings = {
  bucket: "",
  bucketPrefix: "",
  endpoint: undefined,
  region: "us-east-1",
  credentials: undefined,
  forcePathStyle: false,
  publicUrl: "",
}

/**
 * The S3 settings from the environment. `objectsInS3` false (the file backend) reads none of them,
 * so a stray setting cannot stop a service that never talks to S3.
 */
export function s3Settings(objectsInS3: boolean): S3Settings {
  return objectsInS3 ? s3Store(setting("S3_BUCKET")) : UNUSED
}
