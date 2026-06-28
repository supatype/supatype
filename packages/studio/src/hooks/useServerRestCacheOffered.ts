import { useAdminConfig } from "./useAdminConfig.js"
import { useCloudUrl } from "./useCloudUrl.js"

/** Whether Valkey-backed REST caching is offered for this Studio project. */
export function useServerRestCacheOffered(): boolean {
  const cloudUrl = useCloudUrl()
  const config = useAdminConfig()
  if (!cloudUrl) return true
  return (config.tier ?? "free") !== "free"
}
