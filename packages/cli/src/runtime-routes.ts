export interface RuntimeRoute {
  name: string
  serviceName: string
  serviceUrl: string
  paths: string[]
  stripPath?: boolean
  protocols?: string[]
  engineProtected?: boolean
}

export interface RuntimeRouteOptions {
  appUpstream?: string
  staticAppServiceUrl?: string
}

/**
 * Shared route contract used by local/self-host renderers.
 */
export function runtimeRouteSpec(opts: RuntimeRouteOptions = {}): RuntimeRoute[] {
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
      protocols: ["http", "https", "ws", "wss"],
    },
    {
      name: "functions-v1",
      serviceName: "functions-v1",
      serviceUrl: "http://host.docker.internal:54321",
      paths: ["/functions/v1/"],
      stripPath: false,
    },
    {
      name: "studio",
      serviceName: "studio",
      serviceUrl: "http://studio:3002",
      paths: ["/studio/"],
      stripPath: true,
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
