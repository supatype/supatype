import { useEffect, useMemo, useState } from "react"
import type { SupatypeClient } from "@supatype/client"
import { useAdminClient } from "./useAdminClient.js"
import { usePlatform } from "./usePlatform.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { studioGatewayHeaders } from "../lib/studio-gateway-headers.js"
import { projectPlatformUrl, selfHostPlatformBase } from "../lib/platform-url.js"

/**
 * The project's control plane, the same way in both deployment modes.
 *
 * Views call `fetch("realtime/channels")` and get the project-scoped route on whichever control
 * plane this Studio has: Cloud's, with the platform session cookie, or self-host's through the
 * Studio proxy, with the Studio session header. Self-host learns its project ref from
 * `GET /platform/v1/project` once.
 */

export type PlatformMode = "cloud" | "self-host"

/** A control-plane fetch for one project: `path` is relative to `/projects/:ref`. */
export type ProjectFetch = (path: string, init?: RequestInit) => Promise<Response>

export type PlatformApi =
  | { state: "loading" }
  /** No control plane here (demo mode), or self-host's did not say which project it serves. */
  | { state: "unavailable"; status: number | null }
  | { state: "ready"; mode: PlatformMode; projectRef: string; fetch: ProjectFetch }

/** Where a control plane is and what every request to it carries. */
interface PlatformTarget {
  base: string
  init: () => RequestInit
}

type SelfHostAnswer = { ref: string } | { status: number | null }

export function selfHostTarget(client: SupatypeClient): PlatformTarget {
  return {
    base: selfHostPlatformBase(client.url),
    init: () => ({ headers: { ...studioGatewayHeaders(), ...studioAuthHeaders(client) } }),
  }
}

export function cloudTarget(platformUrl: string): PlatformTarget {
  return { base: platformUrl, init: () => ({ credentials: "include" }) }
}

function withInit(target: PlatformTarget, init: RequestInit = {}): RequestInit {
  const own = target.init()
  const headers = new Headers(own.headers)
  new Headers(init.headers).forEach((value, name) => headers.set(name, value))
  return { ...own, ...init, headers }
}

export function projectFetch(target: PlatformTarget, projectRef: string): ProjectFetch {
  return (path, init) => fetch(projectPlatformUrl(target.base, projectRef, path), withInit(target, init))
}

/** Ask self-host's control plane which project it serves. */
export async function selfHostProjectRef(target: PlatformTarget): Promise<SelfHostAnswer> {
  try {
    const res = await fetch(`${target.base}/project`, withInit(target))
    if (!res.ok) return { status: res.status }
    const body = (await res.json()) as { data?: { ref?: unknown } }
    return typeof body.data?.ref === "string" ? { ref: body.data.ref } : { status: res.status }
  } catch {
    return { status: null }
  }
}

/**
 * `enabled: false` asks nothing and stays `loading`, for a caller that renders on every page but
 * needs the control plane only on some.
 */
export function usePlatformApi(opts: { demoMode?: boolean; enabled?: boolean } = {}): PlatformApi {
  const client = useAdminClient()
  const { platformUrl, projectRef } = usePlatform()
  const demo = opts.demoMode === true
  const enabled = opts.enabled !== false
  const cloud = platformUrl !== undefined && projectRef !== undefined
  const [answer, setAnswer] = useState<SelfHostAnswer | null>(null)

  useEffect(() => {
    if (cloud || demo || !enabled) return
    let cancelled = false
    setAnswer(null)
    void selfHostProjectRef(selfHostTarget(client)).then((next) => {
      if (!cancelled) setAnswer(next)
    })
    return () => {
      cancelled = true
    }
  }, [client, cloud, demo, enabled])

  return useMemo((): PlatformApi => {
    if (demo) return { state: "unavailable", status: null }
    if (platformUrl !== undefined && projectRef !== undefined) {
      return { state: "ready", mode: "cloud", projectRef, fetch: projectFetch(cloudTarget(platformUrl), projectRef) }
    }
    if (!enabled || answer === null) return { state: "loading" }
    if (!("ref" in answer)) return { state: "unavailable", status: answer.status }
    return { state: "ready", mode: "self-host", projectRef: answer.ref, fetch: projectFetch(selfHostTarget(client), answer.ref) }
  }, [client, platformUrl, projectRef, answer, demo, enabled])
}
