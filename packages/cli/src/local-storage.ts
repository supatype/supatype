import { join } from "node:path"
import type { SupatypeProjectConfig } from "./project-config.js"

/** Whether a project's objects stay on this machine (anything but `storage.provider: "s3"`). */
export function keepsObjectsLocally(config: SupatypeProjectConfig): boolean {
  return config.storage?.provider !== "s3"
}

/** Where supatype-server's built-in object store keeps a native project's buckets and objects. */
export function serverStoreRoot(stateDir: string): string {
  return join(stateDir, "storage")
}

/**
 * The S3 settings init writes into .env, which native dev and self-host compose hand the storage
 * service as they are there for a project on its own S3 bucket. One list, so the two cannot differ.
 */
export const OWN_BUCKET_S3_SETTINGS = [
  "S3_BUCKET",
  "S3_REGION",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_FORCE_PATH_STYLE",
] as const
