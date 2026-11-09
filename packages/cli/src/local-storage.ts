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
