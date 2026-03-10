import React, { useState, useMemo } from "react"
import type { SupatypeClient } from "@supatype/client"
import type { AdminConfig } from "./config.js"
import { AdminConfigContext } from "./hooks/useAdminConfig.js"
import { AdminClientContext } from "./hooks/useAdminClient.js"
import { LocaleContext, useLocaleState } from "./hooks/useLocale.js"
import { Sidebar } from "./components/Sidebar.js"
import { Dashboard } from "./views/Dashboard.js"
import { ListView } from "./views/ListView.js"
import { EditView } from "./views/EditView.js"
import { GlobalEditView } from "./views/GlobalEditView.js"
import { MediaLibrary } from "./views/MediaLibrary.js"
import { VersionHistory } from "./views/VersionHistory.js"

export interface AdminAppProps {
  config: AdminConfig
  client: SupatypeClient
  basePath?: string
}

export function AdminApp({ config, client, basePath = "/admin" }: AdminAppProps): React.ReactElement {
  const [path, setPath] = useState(basePath)
  const localeState = useLocaleState()

  const navigate = (newPath: string) => {
    const fullPath = newPath.startsWith("/") ? `${basePath}${newPath}` : newPath
    setPath(fullPath)
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", fullPath)
    }
  }

  const relativePath = path.startsWith(basePath) ? path.slice(basePath.length) || "/" : path

  return (
    <AdminConfigContext.Provider value={config}>
      <AdminClientContext.Provider value={client}>
        <LocaleContext.Provider value={localeState}>
          <div className="st-admin">
            <Sidebar currentPath={relativePath} onNavigate={navigate} />
            <main className="st-admin-main">
              <RouteRenderer
                path={relativePath}
                config={config}
                onNavigate={navigate}
              />
            </main>
          </div>
        </LocaleContext.Provider>
      </AdminClientContext.Provider>
    </AdminConfigContext.Provider>
  )
}

function RouteRenderer({
  path,
  config,
  onNavigate,
}: {
  path: string
  config: AdminConfig
  onNavigate: (path: string) => void
}): React.ReactElement {
  // Dashboard
  if (path === "/" || path === "") {
    return <Dashboard />
  }

  // Media library
  if (path === "/media") {
    return <MediaLibrary />
  }

  // Collection list: /collections/:model
  const listMatch = path.match(/^\/collections\/([^/]+)$/)
  if (listMatch) {
    const modelName = listMatch[1]!
    const model = config.models.find((m) => m.name === modelName)
    if (!model) return <div className="st-error">Model "{modelName}" not found</div>
    return <ListView model={model} onNavigate={onNavigate} />
  }

  // Collection create: /collections/:model/create
  const createMatch = path.match(/^\/collections\/([^/]+)\/create$/)
  if (createMatch) {
    const modelName = createMatch[1]!
    const model = config.models.find((m) => m.name === modelName)
    if (!model) return <div className="st-error">Model "{modelName}" not found</div>
    return <EditView model={model} onNavigate={onNavigate} />
  }

  // Version history: /collections/:model/:id/versions
  const versionMatch = path.match(/^\/collections\/([^/]+)\/([^/]+)\/versions$/)
  if (versionMatch) {
    const modelName = versionMatch[1]!
    const recordId = versionMatch[2]!
    const model = config.models.find((m) => m.name === modelName)
    if (!model) return <div className="st-error">Model "{modelName}" not found</div>
    return <VersionHistory model={model} recordId={recordId} onNavigate={onNavigate} />
  }

  // Collection edit: /collections/:model/:id
  const editMatch = path.match(/^\/collections\/([^/]+)\/([^/]+)$/)
  if (editMatch) {
    const modelName = editMatch[1]!
    const recordId = editMatch[2]!
    const model = config.models.find((m) => m.name === modelName)
    if (!model) return <div className="st-error">Model "{modelName}" not found</div>
    return <EditView model={model} recordId={recordId} onNavigate={onNavigate} />
  }

  // Global edit: /globals/:name
  const globalMatch = path.match(/^\/globals\/([^/]+)$/)
  if (globalMatch) {
    const globalName = globalMatch[1]!
    const globalConfig = config.globals.find((g) => g.name === globalName)
    if (!globalConfig) return <div className="st-error">Global "{globalName}" not found</div>
    return <GlobalEditView global={globalConfig} />
  }

  return <div className="st-error">Page not found: {path}</div>
}
