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
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { config } from "./env.js"

export const s3 = new S3Client({
  endpoint: config.s3Endpoint,
  region: config.s3Region,
  credentials: {
    accessKeyId: config.s3AccessKey,
    secretAccessKey: config.s3SecretKey,
  },
  forcePathStyle: config.s3ForcePathStyle,
})

// ─── Bucket operations ─────────────────────────────────────────────────────────

export async function ensureBucket(name: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: name }))
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: name }))
  }
}

export async function deleteBucket(name: string): Promise<void> {
  await s3.send(new DeleteBucketCommand({ Bucket: name }))
}

/**
 * Apply a public-read bucket policy so objects are directly accessible
 * at the S3/MinIO URL without going through the storage proxy.
 * Called when a bucket is created or updated with public: true.
 */
/** Apply a caller-supplied bucket policy document (must be valid IAM JSON). */
export async function applyRawBucketPolicy(name: string, policyJson: string): Promise<void> {
  try {
    await s3.send(new PutPublicAccessBlockCommand({
      Bucket: name,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        IgnorePublicAcls: false,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      },
    }))
  } catch { /* backends may not implement this */ }

  await s3.send(new PutBucketPolicyCommand({
    Bucket: name,
    Policy: policyJson,
  }))
}

export async function applyPublicPolicy(name: string): Promise<void> {
  // AWS requires BlockPublicPolicy/RestrictPublicBuckets to be off before a
  // public bucket policy can be applied. MinIO ignores this call safely.
  try {
    await s3.send(new PutPublicAccessBlockCommand({
      Bucket: name,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        IgnorePublicAcls: false,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      },
    }))
  } catch { /* not supported by all S3-compatible backends — safe to ignore */ }

  await s3.send(new PutBucketPolicyCommand({
    Bucket: name,
    Policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Sid: "PublicReadGetObject",
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${name}/*`,
      }],
    }),
  }))
}

/**
 * Choose S3 policy application: custom JSON wins; else default public-read when `public`.
 */
export async function applyBucketPolicyFromConfig(
  name: string,
  opts: { public: boolean; s3BucketPolicy?: string | null },
): Promise<void> {
  const raw = opts.s3BucketPolicy
  if (raw !== undefined && raw !== null && raw.trim() !== "") {
    await applyRawBucketPolicy(name, raw)
    return
  }
  if (opts.public) await applyPublicPolicy(name)
}

/** Build the direct S3/CDN URL for a public object (path-style or virtual-hosted). */
export function publicObjectUrl(bucket: string, key: string): string {
  const base = config.s3PublicUrl.replace(/\/$/, "")
  return config.s3ForcePathStyle
    ? `${base}/${bucket}/${key}`
    : `${base}/${key}`
}

// ─── Object operations ─────────────────────────────────────────────────────────

export async function putObject(
  bucket: string,
  key: string,
  body: Buffer | ReadableStream | Uint8Array,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  )
}

export async function getObject(
  bucket: string,
  key: string,
): Promise<{ body: Buffer; contentType: string; contentLength: number }> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
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
  const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  return {
    contentType: res.ContentType ?? "application/octet-stream",
    contentLength: res.ContentLength ?? 0,
    lastModified: res.LastModified,
  }
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
}

export async function deleteObjects(
  bucket: string,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    }),
  )
}

export async function listObjects(
  bucket: string,
  prefix: string,
  limit: number,
  offset: number,
): Promise<{ key: string; size: number; lastModified: Date | undefined }[]> {
  const res = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix || undefined,
      MaxKeys: limit + offset,
    }),
  )
  const items = (res.Contents ?? []).slice(offset)
  return items.map((o) => ({
    key: o.Key ?? "",
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
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn },
  )
}

export async function createSignedUploadUrl(
  bucket: string,
  key: string,
  expiresIn: number,
  contentType?: string,
): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(contentType !== undefined && { ContentType: contentType }),
    }),
    { expiresIn },
  )
}
