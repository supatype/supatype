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
): Promise<{ body: ReadableStream; contentType: string; contentLength: number }> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return {
    body: res.Body!.transformToWebStream(),
    contentType: res.ContentType ?? "application/octet-stream",
    contentLength: res.ContentLength ?? 0,
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
