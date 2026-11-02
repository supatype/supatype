/**
 * Where the routes keep object bytes: S3 (the default) or a directory on local disk
 * (`STORAGE_BACKEND=file`). Everything else about a bucket or an object (its rules, size limits,
 * accepted types, access mode, owner and version) is in Postgres, so it is the same whichever
 * backend holds the bytes, and native `supatype dev` enforces exactly what a deployment does.
 */
import { DiskStore, type StoredBytes } from "./disk-store.js"
import { config } from "./env.js"
import * as s3 from "./s3.js"

/**
 * Where an object's bytes are stored: `name/<version>`, a fresh version per upload, or `name` for
 * an object written before versions, whose row has none.
 *
 * Fresh per upload so an overwrite never replaces the bytes being served: the new ones go
 * alongside, the row is switched to them when it commits, and the old ones are deleted after.
 */
export function objectKey(name: string, version: string | null): string {
  return version === null ? name : `${name}/${version}`
}

let disk: DiskStore | undefined

/** The file backend, or undefined when objects are in S3. */
function diskStore(): DiskStore | undefined {
  if (config.storageBackend !== "file") return undefined
  disk ??= new DiskStore(config.storageFilePath)
  return disk
}

export async function ensureBucket(name: string): Promise<void> {
  const local = diskStore()
  await (local ? local.ensureBucket(name) : s3.ensureBucket(name))
}

export async function deleteBucket(name: string): Promise<void> {
  const local = diskStore()
  await (local ? local.deleteBucket(name) : s3.deleteBucket(name))
}

export async function putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
  const local = diskStore()
  await (local ? local.putObject(bucket, key, body, contentType) : s3.putObject(bucket, key, body, contentType))
}

export async function getObject(bucket: string, key: string): Promise<StoredBytes> {
  const local = diskStore()
  return local ? local.getObject(bucket, key) : s3.getObject(bucket, key)
}

export async function deleteObjects(bucket: string, keys: string[]): Promise<void> {
  const local = diskStore()
  await (local ? local.deleteObjects(bucket, keys) : s3.deleteObjects(bucket, keys))
}

/**
 * The bucket's S3 policy, which lets anyone read a public bucket straight from S3. Disk has no
 * address of its own: every read goes through the service, which applies the bucket's rules.
 */
export async function applyBucketPolicyFromConfig(
  name: string,
  opts: { public: boolean; s3BucketPolicy?: string | null },
): Promise<void> {
  if (diskStore() === undefined) await s3.applyBucketPolicyFromConfig(name, opts)
}
