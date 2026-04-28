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
}

/** Escape a string for use inside YAML double quotes. */
function yamlQuotedString(s: string): string {
  return JSON.stringify(s)
}

/**
 * Build full `kong.yml` content. Single source of truth for CLI `dev` and `self-host setup`.
 */
export function buildKongDeclarative(opts: KongDeclarativeOptions = {}): string {
  const gatewayKey = opts.engineGatewayKey?.trim()
  const secured = Boolean(gatewayKey)

  const consumersBlock = secured
    ? `
consumers:
  - username: studio-engine-gateway
    keyauth_credentials:
      - key: ${yamlQuotedString(gatewayKey!)}
`
    : ""

  const engineRoutePlugins = secured
    ? `        plugins:
          - name: key-auth
            config:
              key_names:
                - apikey
              hide_credentials: true
`
    : ""

  return `_format_version: "3.0"
${consumersBlock}
services:
  - name: rest-v1
    url: http://postgrest:3000
    routes:
      - name: rest-v1-all
        strip_path: true
        paths:
          - /rest/v1/
  - name: auth-v1
    url: http://gotrue:9999
    routes:
      - name: auth-v1-all
        strip_path: true
        paths:
          - /auth/v1/
  - name: storage-v1
    url: http://host.docker.internal:5000
    routes:
      - name: storage-v1-all
        strip_path: true
        paths:
          - /storage/v1/
  - name: realtime-v1
    url: http://host.docker.internal:4000
    routes:
      - name: realtime-v1-all
        strip_path: true
        paths:
          - /realtime/v1/
        protocols:
          - http
          - https
          - ws
          - wss
  - name: functions-v1
    url: http://host.docker.internal:54321
    routes:
      - name: functions-v1-all
        strip_path: false
        paths:
          - /functions/v1/
  - name: studio
    url: http://host.docker.internal:3002
    routes:
      - name: studio-all
        strip_path: true
        paths:
          - /studio/
  # Schema engine — protect /studio-config and /sql in production (key-auth when STUDIO_GATEWAY_KEY is set).
  - name: engine-studio-config
    url: http://engine:7500
    routes:
      - name: studio-config-route
        paths:
          - /studio-config
${engineRoutePlugins}
  - name: engine-sql
    url: http://engine:7500
    routes:
      - name: sql-route
        paths:
          - /sql
${engineRoutePlugins}
`
}
