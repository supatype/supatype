export interface RuntimeRoute {
  name: string
  serviceName: string
  serviceUrl: string
  paths: string[]
  stripPath?: boolean
  protocols?: string[]
  engineProtected?: boolean
  /** Route /graphql/v1 to PostgREST /rpc/graphql with graphql_public Content-Profile. */
  graphqlPostgrest?: boolean
}

export interface RuntimeRouteOptions {
  appUpstream?: string
  staticAppServiceUrl?: string
  /** Compose self-host: supatype-server container (functions proxy). */
  functionsServiceUrl?: string
  /**
   * Self-host Compose: Kong forwards API traffic to supatype-server (unified gateway),
   * which proxies to internal services — same model as `supatype dev`.
   */
  unifiedGateway?: boolean
  /** Studio UI upstream (default: in-compose `studio:3002`). */
  studioServiceUrl?: string
  /**
   * Strip `/studio/` before proxying to the Studio upstream.
   * False for host Vite dev (`host.docker.internal`) where `base` is `/studio/`.
   */
  studioStripPath?: boolean
}

const DEFAULT_STUDIO_SERVICE_URL = "http://studio:3002"

function studioServiceUrl(opts: RuntimeRouteOptions): string {
  const url = opts.studioServiceUrl?.trim()
  return url && url.length > 0 ? url : DEFAULT_STUDIO_SERVICE_URL
}

function studioStripPath(opts: RuntimeRouteOptions): boolean {
  return opts.studioStripPath !== false
}

const SERVER_GATEWAY = "http://server:9999"

/**
 * Kong routes when self-host uses supatype-server as the single API gateway.
 */
function runtimeRouteSpecUnified(opts: RuntimeRouteOptions): RuntimeRoute[] {
  const studioUrl = studioServiceUrl(opts)
  const stripStudio = studioStripPath(opts)
  return [
    {
      name: "rest-v1",
      serviceName: "supatype-server-rest",
      serviceUrl: SERVER_GATEWAY,
      paths: ["/rest/v1/"],
      stripPath: false,
    },
    {
      name: "auth-v1",
      serviceName: "supatype-server-auth",
      serviceUrl: SERVER_GATEWAY,
      paths: ["/auth/v1/"],
      stripPath: false,
    },
    {
      name: "admin-v1",
      serviceName: "supatype-server-admin",
      serviceUrl: SERVER_GATEWAY,
      paths: ["/admin/v1/"],
      stripPath: false,
    },
    {
      name: "storage-v1",
      serviceName: "supatype-server-storage",
      serviceUrl: SERVER_GATEWAY,
      paths: ["/storage/v1/"],
      stripPath: false,
    },
    {
      name: "realtime-v1",
      serviceName: "supatype-server-realtime",
      serviceUrl: SERVER_GATEWAY,
      paths: ["/realtime/v1/"],
      stripPath: false,
      protocols: ["http", "https"],
    },
    {
      name: "functions-v1",
      serviceName: "supatype-server-functions",
      serviceUrl: SERVER_GATEWAY,
      paths: ["/functions/v1/"],
      stripPath: false,
    },
    {
      name: "graphql-v1",
      serviceName: "postgrest-graphql",
      serviceUrl: "http://postgrest:3000/rpc/graphql",
      paths: ["/graphql/v1"],
      stripPath: true,
      graphqlPostgrest: true,
    },
    {
      name: "studio-config-route",
      serviceName: "supatype-server-studio-config",
      serviceUrl: SERVER_GATEWAY,
      paths: ["/studio-config"],
      stripPath: false,
    },
    {
      name: "sql-route",
      serviceName: "supatype-server-sql",
      serviceUrl: SERVER_GATEWAY,
      paths: ["/sql"],
      stripPath: false,
    },
    {
      name: "studio-auth",
      serviceName: "supatype-server-studio-auth",
      serviceUrl: SERVER_GATEWAY,
      paths: ["/studio/auth/"],
      stripPath: false,
    },
    {
      name: "studio-proxy",
      serviceName: "supatype-server-studio-proxy",
      serviceUrl: SERVER_GATEWAY,
      paths: ["/studio/proxy/"],
      stripPath: false,
    },
    {
      name: "studio-exact",
      serviceName: "studio-exact",
      serviceUrl: studioUrl,
      paths: ["~/studio$"],
      stripPath: stripStudio,
    },
    {
      name: "studio",
      serviceName: "studio",
      serviceUrl: studioUrl,
      paths: ["/studio/"],
      stripPath: stripStudio,
    },
    {
      name: "app-root",
      serviceName: "supatype-server-app",
      serviceUrl: SERVER_GATEWAY,
      paths: ["/"],
      stripPath: false,
    },
  ]
}

/**
 * Legacy split-stack routes (PostgREST/storage/realtime directly from Kong).
 * Kept for tests or explicit opt-out only — self-host uses unifiedGateway.
 */
function runtimeRouteSpecSplit(opts: RuntimeRouteOptions): RuntimeRoute[] {
  const studioUrl = studioServiceUrl(opts)
  const stripStudio = studioStripPath(opts)
  const routes: RuntimeRoute[] = [
    {
      name: "rest-v1",
      serviceName: "rest-v1",
      serviceUrl: "http://postgrest:3000",
      paths: ["/rest/v1/"],
      stripPath: true,
    },
    {
      name: "auth-v1",
      serviceName: "auth-v1",
      serviceUrl: "http://server:9999",
      paths: ["/auth/v1/"],
      stripPath: true,
    },
    {
      name: "admin-v1",
      serviceName: "admin-v1",
      serviceUrl: "http://server:9999",
      paths: ["/admin/v1/"],
      stripPath: false,
    },
    {
      name: "storage-v1",
      serviceName: "storage-v1",
      serviceUrl: "http://storage:5000",
      paths: ["/storage/v1/"],
      stripPath: true,
    },
    {
      name: "realtime-v1",
      serviceName: "realtime-v1",
      serviceUrl: "http://realtime:4000",
      paths: ["/realtime/v1/"],
      stripPath: true,
      protocols: ["http", "https"],
    },
    {
      name: "functions-v1",
      serviceName: "functions-v1",
      serviceUrl: opts.functionsServiceUrl?.trim() || "http://server:9999",
      paths: ["/functions/v1/"],
      stripPath: false,
    },
    {
      name: "graphql-v1",
      serviceName: "postgrest-graphql",
      serviceUrl: "http://postgrest:3000/rpc/graphql",
      paths: ["/graphql/v1"],
      stripPath: true,
      graphqlPostgrest: true,
    },
    {
      name: "studio-auth",
      serviceName: "auth-v1",
      serviceUrl: "http://server:9999",
      paths: ["/studio/auth/"],
      stripPath: false,
    },
    {
      name: "studio-proxy",
      serviceName: "auth-v1",
      serviceUrl: "http://server:9999",
      paths: ["/studio/proxy/"],
      stripPath: false,
    },
    {
      name: "studio-exact",
      serviceName: "studio-exact",
      serviceUrl: studioUrl,
      paths: ["~/studio$"],
      stripPath: stripStudio,
    },
    {
      name: "studio",
      serviceName: "studio",
      serviceUrl: studioUrl,
      paths: ["/studio/"],
      stripPath: stripStudio,
    },
    {
      name: "studio-config-route",
      serviceName: "engine-studio-config",
      serviceUrl: "http://engine:7500",
      paths: ["/studio-config"],
      engineProtected: true,
    },
    {
      name: "sql-route",
      serviceName: "engine-sql",
      serviceUrl: "http://engine:7500",
      paths: ["/sql"],
      engineProtected: true,
    },
  ]

  const staticServiceUrl = opts.staticAppServiceUrl?.trim()
  if (staticServiceUrl && staticServiceUrl.length > 0) {
    routes.push({
      name: "app-root",
      serviceName: "app-root",
      serviceUrl: staticServiceUrl,
      paths: ["/"],
      stripPath: false,
    })
    return routes
  }

  if (opts.appUpstream && opts.appUpstream.trim().length > 0) {
    routes.push({
      name: "app-root",
      serviceName: "app-root",
      serviceUrl: opts.appUpstream.trim(),
      paths: ["/"],
      stripPath: false,
    })
  }

  return routes
}

/**
 * Shared route contract used by local/self-host renderers.
 */
export function runtimeRouteSpec(opts: RuntimeRouteOptions = {}): RuntimeRoute[] {
  if (opts.unifiedGateway) {
    return runtimeRouteSpecUnified(opts)
  }
  return runtimeRouteSpecSplit(opts)
}
