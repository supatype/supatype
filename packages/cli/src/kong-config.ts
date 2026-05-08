/**
 * Kong declarative config for local dev and self-hosted production.
 * When `engineGatewayKey` is set, `/studio-config` and `/sql` require `apikey` (key-auth).
 */

export interface KongDeclarativeOptions {
  /**
   * When non-empty, Kong `key-auth` is enabled on engine routes; clients must send
   * header `apikey: <key>` (same convention as PostgREST). Omit for open local dev.
   */
  engineGatewayKey?: string | undefined
  appUpstream?: string | undefined
  staticAppServiceUrl?: string | undefined
}

/** Escape a string for use inside YAML double quotes. */
function yamlQuotedString(s: string): string {
  return JSON.stringify(s)
}

import { runtimeRouteSpec } from "./runtime-routes.js"

/**
 * Build full `kong.yml` content. Single source of truth for CLI `dev` and `self-host setup`.
 */
export function buildKongDeclarative(opts: KongDeclarativeOptions = {}): string {
  const gatewayKey = opts.engineGatewayKey?.trim()
  const secured = Boolean(gatewayKey)
  const routes = runtimeRouteSpec({
    ...(opts.appUpstream !== undefined && { appUpstream: opts.appUpstream }),
    ...(opts.staticAppServiceUrl !== undefined && { staticAppServiceUrl: opts.staticAppServiceUrl }),
  })

  const consumersBlock = secured
    ? `
consumers:
  - username: studio-engine-gateway
    keyauth_credentials:
      - key: ${yamlQuotedString(gatewayKey!)}
`
    : ""

  const servicesBlock = routes.map((route) => {
    const routePlugins = route.engineProtected && secured
      ? `        plugins:
          - name: key-auth
            config:
              key_names:
                - apikey
              hide_credentials: true
`
      : ""
    const protocols = route.protocols && route.protocols.length > 0
      ? `        protocols:\n${route.protocols.map((p) => `          - ${p}`).join("\n")}\n`
      : ""
    const stripPath = route.stripPath ?? false
    return `  - name: ${route.serviceName}
    url: ${route.serviceUrl}
    routes:
      - name: ${route.name}
        strip_path: ${stripPath}
        paths:
${route.paths.map((path) => `          - ${path}`).join("\n")}
${protocols}${routePlugins}`
  }).join("\n")

  return `_format_version: "3.0"
${consumersBlock}
services:
${servicesBlock}
`
}
