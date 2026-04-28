import { join } from "node:path"

/**
 * Returns env vars that configure supatype-server to use local-disk storage.
 * Spread into the server process env when config.storage?.provider !== "s3".
 *
 * @param stateDir  Per-project state directory (e.g. ~/.supatype/projects/{name}/)
 */
export function localStorageEnv(stateDir: string): Record<string, string> {
  return {
    STORAGE_PROVIDER: "local",
    STORAGE_PATH: join(stateDir, "storage"),
  }
}
