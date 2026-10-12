import { useEffect, useState } from "react"
import { usePlatformApi, type PlatformApi } from "./usePlatformApi.js"
import { useStudioCapability, type StudioCapability } from "./useStudioCapability.js"

/**
 * Whether this Studio can show the Realtime Inspector, which the route and the nav both ask.
 *
 * Only once this deployment's control plane answers for it: a Studio in front of an older server or
 * control plane has no Inspector to show, and offering one whose every request fails would promise
 * what is not there. Self-host's answer is `GET /platform/v1/project`, which only an Inspector-aware
 * control plane serves and only an Inspector-capable role may reach; Cloud's is the channels route.
 */

export type InspectorAvailability = "checking" | "coming-soon" | "forbidden" | "ready"

/** What an answer from the control plane says about the Inspector being here. */
export function availabilityFromStatus(status: number | null): InspectorAvailability {
  if (status === 401 || status === 403) return "forbidden"
  if (status === 404 || status === null) return "coming-soon"
  // 200, and also 501 (realtime off) and 503 (realtime down): the Inspector is here, and its tabs
  // say why there is nothing to inspect.
  return "ready"
}

/** Whether the capability, once known, rules the Inspector out for this user. */
export function capabilityForbids(capability: Pick<StudioCapability, "role" | "permissions">): boolean {
  return capability.role !== null && capability.permissions["realtimeInspect"] !== true
}

/** Cloud's control plane, asked about the channels route itself; undefined until it answers. */
function useCloudProbe(api: PlatformApi): number | null | undefined {
  const [probed, setProbed] = useState<number | null | undefined>(undefined)
  const cloudFetch = api.state === "ready" && api.mode === "cloud" ? api.fetch : null

  useEffect(() => {
    if (cloudFetch === null) return
    let cancelled = false
    void cloudFetch("realtime/channels")
      .then((res) => res.status)
      .catch(() => null)
      .then((status) => {
        if (!cancelled) setProbed(status)
      })
    return () => {
      cancelled = true
    }
  }, [cloudFetch])

  return probed
}

export function useInspectorAvailability(opts: { enabled?: boolean; demoMode?: boolean } = {}): {
  availability: InspectorAvailability
  api: PlatformApi
} {
  const api = usePlatformApi({ demoMode: opts.demoMode ?? false, enabled: opts.enabled ?? true })
  const capability = useStudioCapability()
  const probed = useCloudProbe(api)

  const availability = ((): InspectorAvailability => {
    if (capabilityForbids(capability)) return "forbidden"
    if (api.state === "loading") return "checking"
    if (api.state === "unavailable") return availabilityFromStatus(api.status)
    if (api.mode === "self-host") return "ready"
    return probed === undefined ? "checking" : availabilityFromStatus(probed)
  })()
  return { availability, api }
}
