import type { SupatypeClient } from "@supatype/client"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { bodyErrorText, isBoolean, isNumber, isOneOf, isRecordOf, isShape, isString, optional, readJson, readJsonObject, type Guard } from "./json.js"
import { studioAuthHeaders } from "./studio-auth-headers.js"
import type {
  HostRead,
  SiteHeader,
  StaticSiteHost,
  StaticSiteOverview,
  StaticSiteSettings,
} from "./static-site-host.js"

/**
 * GET /admin/v1/site/status, which the gateway answers for the app mount at `/`: what it is set to
 * serve, and for a static app what is on disk. Requires the service role key, which Studio's proxy
 * adds for a signed-in administrator.
 */
interface SiteStatus {
  mode: "none" | "static" | "proxy"
  static_dir?: string
  upstream?: string
  spa_fallback: boolean
  /** True when `build.spa` in the config set `spa_fallback`; absent from a gateway that does not say. */
  spa_fallback_from_config?: boolean
  serving: boolean
  file_count: number
  total_bytes: number
  cache_control?: { html: string; hashed_assets: string; prefixes: Record<string, string> }
}

const isCacheControl = isShape({ html: isString, hashed_assets: isString, prefixes: isRecordOf(isString) })

export const isSiteStatus: Guard<SiteStatus> = isShape({
  mode: isOneOf(["none", "static", "proxy"] as const),
  static_dir: optional(isString),
  upstream: optional(isString),
  spa_fallback: isBoolean,
  spa_fallback_from_config: optional(isBoolean),
  serving: isBoolean,
  file_count: isNumber,
  total_bytes: isNumber,
  cache_control: optional(isCacheControl),
})

async function fetchSiteStatus(client: SupatypeClient): Promise<SiteStatus> {
  const res = await fetch(`${client.url}/admin/v1/site/status`, { headers: studioAuthHeaders(client), credentials: "include" })
  if (!res.ok) {
    throw new Error(bodyErrorText(await readJsonObject(res)) ?? `site status request failed (${res.status})`)
  }
  return readJson(res, isSiteStatus)
}

/**
 * Whether this gateway has a site status route at all. A 404 means it does not (a server older than
 * the route), so there is no site to describe; any other answer, including a refusal or a failure,
 * leaves the group in place for its pages to explain.
 */
async function fetchSiteRouteExists(client: SupatypeClient): Promise<boolean> {
  const res = await fetch(`${client.url}/admin/v1/site/status`, { headers: studioAuthHeaders(client), credentials: "include" })
  return res.status !== 404
}

/**
 * Where the app at `/` is reached: the gateway's own origin. `client.url` is the gateway, or its
 * Studio proxy path on the same origin, so a relative one is taken against the page.
 */
export function siteAddress(clientUrl: string, pageOrigin: string): string {
  return new URL(clientUrl, pageOrigin).origin
}

function pageOrigin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin
}

function overviewOf(status: SiteStatus, address: string): StaticSiteOverview {
  const isStatic = status.mode === "static"
  return {
    address: status.mode === "none" ? null : address,
    mode: status.mode,
    staticDir: status.static_dir ?? null,
    upstream: status.upstream ?? null,
    serving: status.serving,
    fileCount: isStatic ? status.file_count : null,
    totalBytes: isStatic ? status.total_bytes : null,
  }
}

function headersOf(status: SiteStatus): SiteHeader[] {
  const cache = status.cache_control
  if (!cache) return []
  return [
    { name: "Cache-Control", value: cache.html, appliesTo: "HTML pages" },
    { name: "Cache-Control", value: cache.hashed_assets, appliesTo: "Hashed assets" },
    ...Object.entries(cache.prefixes).map(([prefix, value]) => ({ name: "Cache-Control", value, appliesTo: prefix })),
  ]
}

/**
 * The mode reaches the gateway from `supatype.config.ts` (`app`): the CLI writes it into the stack's
 * environment. The SPA fallback is the config's only when the gateway says so (`build.spa` is set);
 * otherwise it is the framework's default. The cache headers are environment or built-in defaults, so
 * they are not marked as the config's.
 */
export function settingsOf(status: SiteStatus): StaticSiteSettings {
  return {
    mode: status.mode,
    spaFallback: status.mode === "static" && status.spa_fallback,
    headers: headersOf(status),
    fromConfig: status.spa_fallback_from_config === true ? ["mode", "spaFallback"] : ["mode"],
  }
}

function useSiteStatus(): HostRead<SiteStatus> & { address: string } {
  const client = useAdminClient()
  const { data, loading, error } = useApiQuery(() => fetchSiteStatus(client), [client])
  return { data, loading, error, address: siteAddress(client.url, pageOrigin()) }
}

/** Self-host Studio's host: the gateway's own status route. It has no Deployments page. */
export const selfHostStaticSite: StaticSiteHost = {
  useOffered() {
    const client = useAdminClient()
    const { data } = useApiQuery(() => fetchSiteRouteExists(client), [client])
    return data !== false
  },
  useOverview() {
    const { data, loading, error, address } = useSiteStatus()
    return { data: data === null ? null : overviewOf(data, address), loading, error }
  },
  useSettings() {
    const { data, loading, error } = useSiteStatus()
    return { data: data === null ? null : settingsOf(data), loading, error }
  },
}
