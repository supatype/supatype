import { isArrayOf, isShape, isString, optional, type Guard } from "./json.js"

/**
 * What the hosting page injects as `window.__SUPATYPE_CLOUD__`. The self-host and dev Studio
 * container writes it at start from `SUPATYPE_CLOUD_JSON`, which the CLI renders.
 */
export interface RuntimeConfig {
  url?: string
  anonKey?: string
  serviceRoleKey?: string
  /** `studio.auth.providers` from supatype.config.ts: the only providers Studio's sign-in offers. */
  authProviders?: string[]
}

const isRuntimeConfig: Guard<RuntimeConfig> = isShape({
  url: optional(isString),
  anonKey: optional(isString),
  serviceRoleKey: optional(isString),
  authProviders: optional(isArrayOf(isString)),
})

/** The injected runtime config, or nothing when the page injected none or something unreadable. */
export function injectedRuntimeConfig(): RuntimeConfig {
  if (typeof window === "undefined" || !("__SUPATYPE_CLOUD__" in window)) return {}
  const injected = window.__SUPATYPE_CLOUD__
  return isRuntimeConfig(injected) ? injected : {}
}
