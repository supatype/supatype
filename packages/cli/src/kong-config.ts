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
  functionsServiceUrl?: string | undefined
  /** Self-host: route API paths through supatype-server (see runtime-routes). */
  unifiedGateway?: boolean | undefined
  /** Studio UI upstream (default: in-compose `studio:3002`). */
  studioServiceUrl?: string | undefined
  /** See {@link RuntimeRouteOptions.studioStripPath}. */
  studioStripPath?: boolean | undefined
  /**
   * When set, append a global Kong `acme` plugin (Let's Encrypt) with RESP
   * storage so the self-host gateway provisions and renews TLS automatically.
   */
  acme?: { email: string; domain: string; redisHost: string } | undefined
}

/** Escape a string for use inside YAML double quotes. */
function yamlQuotedString(s: string): string {
  return JSON.stringify(s)
}

/**
 * A raw request path with a part that is empty, "." or ".." (a "." spelled `%2E` or `%2e` too).
 * A trailing "/" is not a part, so `/rest/v1/` passes, and a dot inside a name (`a.b`, `.vite`,
 * `...`) is a name. Written where PCRE and JavaScript regexes agree, so the tests can run it.
 */
const STEP_PART_PATTERN = String.raw`/(?:\.|%2e){1,2}(?:/|$)|//`

/**
 * 0.9.1 release test RB2 (#298): Kong resolves "." and ".." parts and merges "//" before it routes
 * and proxies, so `/storage/v1/object/b/x/../a` wrote the object "a", and `/studio/../auth/v1/...`
 * reached auth. Native has no Kong, and there the storage service refuses such a name with 400 and
 * the server sends such a path to no API. This refuses it on every Supatype route, in the access
 * phase, so it judges the route Kong chose: `/studio/../auth/...` is refused on the auth route. The
 * app's own route never carries it (`servesApp`), so the app's paths reach it as they always did.
 * `get_raw_path` is the path as the client sent it, without the query string.
 */
const RAW_PATH_GUARD = `          - name: pre-function
            config:
              access:
                - |
                  local path = kong.request.get_raw_path()
                  if ngx.re.find(path, [[${STEP_PART_PATTERN}]], "joi") then
                    return kong.response.exit(400, { error = '"' .. path .. '": invalid request path' })
                  end
`

/** The engine routes' key check, when the gateway has a key. */
const ENGINE_KEY_AUTH = `          - name: key-auth
            config:
              key_names:
                - apikey
              hide_credentials: true
`

/** GraphQL goes to PostgREST's `rpc/graphql`, which reads the schema from this header. */
const GRAPHQL_PROFILE = `          - name: request-transformer
            config:
              add:
                headers:
                  - Content-Profile:graphql_public
`

/** A route's `plugins:` list, one key however many plugins it has, or nothing. */
function routePlugins(route: RuntimeRoute, secured: boolean): string {
  const plugins = [
    ...(route.servesApp === true ? [] : [RAW_PATH_GUARD]),
    ...(route.engineProtected === true && secured ? [ENGINE_KEY_AUTH] : []),
    ...(route.graphqlPostgrest === true ? [GRAPHQL_PROFILE] : []),
  ]
  return plugins.length === 0 ? "" : `        plugins:\n${plugins.join("")}`
}

import { runtimeRouteSpec, type RuntimeRoute } from "./runtime-routes.js"

/**
 * Build full `kong.yml` content. Single source of truth for CLI `dev` and `self-host setup`.
 */
export function buildKongDeclarative(opts: KongDeclarativeOptions = {}): string {
  const gatewayKey = opts.engineGatewayKey?.trim()
  const secured = Boolean(gatewayKey)
  const routes = runtimeRouteSpec({
    ...(opts.unifiedGateway === true && { unifiedGateway: true }),
    ...(opts.unifiedGateway !== true && opts.appUpstream !== undefined && { appUpstream: opts.appUpstream }),
    ...(opts.unifiedGateway !== true &&
      opts.staticAppServiceUrl !== undefined && { staticAppServiceUrl: opts.staticAppServiceUrl }),
    ...(opts.functionsServiceUrl !== undefined && { functionsServiceUrl: opts.functionsServiceUrl }),
    ...(opts.studioServiceUrl !== undefined && { studioServiceUrl: opts.studioServiceUrl }),
    ...(opts.studioStripPath === false && { studioStripPath: false }),
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
${protocols}${routePlugins(route, secured)}`
  }).join("\n")

  const acme = opts.acme
  const pluginsBlock = acme
    ? `
plugins:
  - name: acme
    config:
      account_email: ${yamlQuotedString(acme.email)}
      tos_accepted: true
      domains:
        - ${yamlQuotedString(acme.domain)}
      storage: redis
      storage_config:
        redis:
          host: ${yamlQuotedString(acme.redisHost)}
          port: 6379
`
    : ""

  return `_format_version: "3.0"
${consumersBlock}
services:
${servicesBlock}
${pluginsBlock}`
}
