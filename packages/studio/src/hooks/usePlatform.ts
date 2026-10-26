import { createContext, useContext } from "react"

export interface PlatformContext {
  platformUrl: string | undefined
  projectRef: string | undefined
}

export const PlatformCtx = createContext<PlatformContext>({
  platformUrl: undefined,
  projectRef: undefined,
})

export function usePlatform(): PlatformContext {
  return useContext(PlatformCtx)
}

/**
 * Returns a fetch wrapper for cloud control-plane routes, or null when not
 * in cloud mode. Views must handle null gracefully: say what self-host does instead, never
 * upsell a feature that Cloud does not run either.
 *
 * Usage:
 *   const pf = usePlatformFetch()
 *   const { projectRef } = usePlatform()
 *   if (!pf) return <SelfHostCorsSettings />
 *   const res = await pf(`projects/${projectRef}/config`)
 */
export function usePlatformFetch(): ((url: string, init?: RequestInit) => Promise<Response>) | null {
  const { platformUrl, projectRef } = usePlatform()
  if (!platformUrl || !projectRef) return null
  return (url, init) =>
    fetch(`${platformUrl}/${url}`, { credentials: "include", ...init })
}
