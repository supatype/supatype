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
 * Returns env vars that configure supatype-server to use local-disk storage, for a project that
 * {@link keepsObjectsLocally} when native dev does not run the storage service.
 *
 * @param stateDir  Per-project state directory (e.g. ~/.supatype/projects/{name}/)
 */
export function localStorageEnv(stateDir: string): Record<string, string> {
  return {
    STORAGE_PROVIDER: "local",
    STORAGE_PATH: serverStoreRoot(stateDir),
  }
}
