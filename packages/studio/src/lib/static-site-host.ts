import { createContext, useContext } from "react"
import type React from "react"

/**
 * What the Static site pages read, and who answers.
 *
 * The pages (Overview, Settings) are the same on self-host and on Cloud. They never fetch: they ask
 * the host Studio was given. Self-host Studio's host calls the gateway's `/admin/v1/site/status`;
 * Cloud's calls the control plane and adds the fields only Cloud has. A host that offers a
 * Deployments page says so by providing one, so the page, its nav entry and its route exist on Cloud
 * and nowhere else.
 */

/** What answers `/` on this project. */
export type StaticSiteMode = "none" | "static" | "proxy"

/** The result of a host's read, in the shape the pages render from. */
export interface HostRead<T> {
  data: T | null
  loading: boolean
  /** Why the read failed, verbatim from the host. */
  error: string | null
}

/** Cloud's extra facts about the live site. Absent on self-host, which keeps no versions. */
export interface LiveSite {
  version: string
  /** When the live version was deployed, ISO 8601, or null when that is not known. */
  deployedAt: string | null
  sizeBytes: number
  /** The plan's site size. */
  planBytes: number
  overPlan: boolean
}

/** The Overview page's facts. */
export interface StaticSiteOverview {
  /** Where the site is reached, or null when the host cannot say. */
  address: string | null
  mode: StaticSiteMode
  /** The served directory, when `mode` is "static" and the host reports one. */
  staticDir: string | null
  /** The proxied address, when `mode` is "proxy". */
  upstream: string | null
  /** Whether a request for the site would be answered with something. */
  serving: boolean
  /** Files being served. Null when the host does not count them (a proxy has none). */
  fileCount: number | null
  totalBytes: number | null
  /** Cloud only. */
  live?: LiveSite
}

/** One response header the site is served with. */
export interface SiteHeader {
  name: string
  value: string
  /** What the header applies to, in words: "HTML pages", "Hashed assets", "/downloads/". */
  appliesTo: string
}

/** The Settings that can come from `supatype.config.ts`. */
export type StaticSiteSettingKey = "mode" | "spaFallback" | "headers"

/** The Settings page's facts. */
export interface StaticSiteSettings {
  mode: StaticSiteMode
  spaFallback: boolean
  headers: SiteHeader[]
  /**
   * The settings whose value is set in `supatype.config.ts`. The config wins over anything saved
   * elsewhere (the CORS rule), so the page shows these read-only and says where to change them.
   */
  fromConfig: StaticSiteSettingKey[]
  /**
   * Cloud's custom domains page, as a path in Studio. The Settings page does not show the link yet:
   * it stays hidden until custom domains serve the site (see CUSTOM_DOMAINS_LINK_VISIBLE).
   */
  customDomainsPath?: string
}

/**
 * The host interface. Read it through {@link useStaticSiteHost}.
 *
 * The two `use` members are React hooks, called by the pages on every render, so a host must give
 * the same object each time and each hook must follow the rules of hooks.
 */
export interface StaticSiteHost {
  useOverview(): HostRead<StaticSiteOverview>
  useSettings(): HostRead<StaticSiteSettings>
  /**
   * The Deployments page, history and rollback. Cloud only: its presence adds the page, its nav
   * entry and its route to the group, and an absent one means none of the three exist.
   */
  Deployments?: React.ComponentType
}

export const StaticSiteCtx = createContext<StaticSiteHost | undefined>(undefined)

/** The host Studio was given, or undefined when it was given none, in which case there is no group. */
export function useStaticSiteHost(): StaticSiteHost | undefined {
  return useContext(StaticSiteCtx)
}

/** The host, for a page that is only mounted when there is one. */
export function useRequiredStaticSiteHost(): StaticSiteHost {
  const host = useStaticSiteHost()
  if (!host) throw new Error("The Static site pages need a StaticSiteHost")
  return host
}
