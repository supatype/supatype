import type React from "react"

// ─── Extension Types ──────────────────────────────────────────────────────────
// These types define how host applications (e.g. the cloud studio) can extend
// the core studio with additional routes, sidebar sections, and providers.

export type StudioMode = "content" | "developer"

export interface NavItem {
  href: string
  label: string
  icon?: string
}

export interface SidebarSection {
  title: string
  /** Which sidebar mode shows this section. */
  mode: StudioMode
  items: NavItem[]
}

export interface RouteExtension {
  path: string
  element: React.ReactElement
}

export interface StudioExtension {
  /** Additional routes to register inside the studio layout. */
  routes?: RouteExtension[]
  /** Additional sidebar nav sections appended after the core nav items. */
  sidebarSections?: SidebarSection[]
  /** Components rendered in the top bar left slot (after the logo and "/"). */
  topBarLeftItems?: React.ComponentType[]
  /** Components rendered in the top bar right side (before the avatar). */
  topBarItems?: React.ComponentType[]
  /** Context providers that wrap the entire studio. Rendered outermost-first. */
  providers?: React.ComponentType<{ children: React.ReactNode }>[]
}

export interface StudioCoreProps {
  /** Admin config for the current project. */
  config: AdminConfig | null
  /** Supatype client instance for data operations. */
  client: SupatypeClient | null
  /** Extensions provided by the host app (e.g. cloud-specific routes, sidebar items). */
  extensions?: StudioExtension
  /** Default sidebar mode. Defaults to "developer". */
  defaultMode?: StudioMode
  /** Self-host: user chose "Explore with sample data" — show a demo badge in the shell. */
  demoMode?: boolean
  /**
   * Base URL of the cloud control plane (e.g. https://api.supatype.com).
   * Undefined in self-hosted / local dev mode. Views that require cloud
   * infrastructure use this to detect mode and show an upsell when absent.
   */
  platformUrl?: string
  /**
   * Project ref slug for cloud control-plane API calls (e.g. "kxv4m2np").
   * Required alongside platformUrl.
   */
  projectRef?: string
  /**
   * Marketing URL for the Supatype Cloud offering (e.g. https://supatype.com).
   * When set, cloud-upsell screens show a CTA button linking here.
   */
  cloudUrl?: string
}

// Re-export config types for convenience
export type { AdminConfig, ModelConfig, GlobalConfig, FieldConfig, WidgetType } from "./config.js"

// Forward-declare the client type so consumers don't need @supatype/client
import type { SupatypeClient } from "@supatype/client"
import type { AdminConfig } from "./config.js"
export type { SupatypeClient }
