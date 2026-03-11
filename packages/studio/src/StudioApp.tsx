import React, { useState } from "react"
import type { SupatypeClient } from "@supatype/client"
import type { AdminConfig } from "./config.js"
import { AdminConfigContext } from "./hooks/useAdminConfig.js"
import { AdminClientContext, useAdminClient } from "./hooks/useAdminClient.js"
import { LocaleContext, useLocaleState } from "./hooks/useLocale.js"
import { Sidebar } from "./components/Sidebar.js"
import type { StudioMode } from "./components/Sidebar.js"
import { TopBar } from "./components/TopBar.js"
import { cn } from "./lib/utils.js"

// Re-export for dev tool views that import useStudioClient
export const useStudioClient = useAdminClient

// CMS views
import { Dashboard } from "./views/Dashboard.js"
import { ListView } from "./views/ListView.js"
import { EditView } from "./views/EditView.js"
import { GlobalEditView } from "./views/GlobalEditView.js"
import { MediaLibrary } from "./views/MediaLibrary.js"
import { VersionHistory } from "./views/VersionHistory.js"

// Developer tool views
import { SchemaView } from "./views/SchemaView.js"
import { DataExplorer } from "./views/DataExplorer.js"
import { SqlRunner } from "./views/SqlRunner.js"
import { MigrationHistory } from "./views/MigrationHistory.js"
import { AuthManagement } from "./views/AuthManagement.js"
import { StorageBrowser } from "./views/StorageBrowser.js"
import { ApiDocs } from "./views/ApiDocs.js"
import { LogsViewer } from "./views/LogsViewer.js"
import { Settings } from "./views/Settings.js"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StudioAppProps {
  config: AdminConfig
  client: SupatypeClient
  basePath?: string
}

// ─── App ──────────────────────────────────────────────────────────────────────

export function StudioApp({ config, client, basePath = "/studio" }: StudioAppProps): React.ReactElement {
  const [path, setPath] = useState(basePath)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mode, setMode] = useState<StudioMode>("content")
  const localeState = useLocaleState(config)

  const navigate = (newPath: string) => {
    const fullPath = newPath.startsWith("/") ? `${basePath}${newPath}` : newPath
    setPath(fullPath)
    setSidebarOpen(false)
    // Auto-switch mode based on route
    if (newPath.startsWith("/dev")) {
      setMode("developer")
    } else {
      setMode("content")
    }
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", fullPath)
    }
  }

  const relativePath = path.startsWith(basePath) ? path.slice(basePath.length) || "/" : path

  return (
    <AdminConfigContext.Provider value={config}>
      <AdminClientContext.Provider value={client}>
        <LocaleContext.Provider value={localeState}>
          <div className="flex h-screen bg-background overflow-hidden">
            {/* Sidebar — desktop */}
            <Sidebar
              currentPath={relativePath}
              onNavigate={navigate}
              config={config}
              mode={mode}
              onModeChange={setMode}
              collapsed={sidebarCollapsed}
              onCollapsedChange={setSidebarCollapsed}
              className="hidden md:flex"
            />

            {/* Sidebar — mobile overlay */}
            {sidebarOpen && (
              <>
                <div
                  className="fixed inset-0 bg-black/40 z-40 md:hidden"
                  onClick={() => setSidebarOpen(false)}
                />
                <Sidebar
                  currentPath={relativePath}
                  onNavigate={navigate}
                  config={config}
                  mode={mode}
                  onModeChange={setMode}
                  collapsed={false}
                  onCollapsedChange={setSidebarCollapsed}
                  className="fixed top-0 left-0 h-screen z-50 md:hidden"
                />
              </>
            )}

            {/* Main area */}
            <div className="flex-1 flex flex-col min-w-0">
              <TopBar
                currentPath={relativePath}
                config={config}
                mode={mode}
                onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
              />
              <main id="studio-main" className="flex-1 overflow-y-auto p-6">
                <RouteRenderer
                  path={relativePath}
                  config={config}
                  onNavigate={navigate}
                />
              </main>
            </div>
          </div>
        </LocaleContext.Provider>
      </AdminClientContext.Provider>
    </AdminConfigContext.Provider>
  )
}

// ─── Router ───────────────────────────────────────────────────────────────────

function RouteRenderer({
  path,
  config,
  onNavigate,
}: {
  path: string
  config: AdminConfig
  onNavigate: (path: string) => void
}): React.ReactElement {
  if (path === "/" || path === "") return <Dashboard />
  if (path === "/media") return <MediaLibrary />

  const listMatch = path.match(/^\/collections\/([^/]+)$/)
  if (listMatch) {
    const modelName = listMatch[1]!
    const model = config.models.find((m) => m.name === modelName)
    if (!model) return <PageError>Model &quot;{modelName}&quot; not found</PageError>
    return <ListView model={model} onNavigate={onNavigate} />
  }

  const createMatch = path.match(/^\/collections\/([^/]+)\/create$/)
  if (createMatch) {
    const modelName = createMatch[1]!
    const model = config.models.find((m) => m.name === modelName)
    if (!model) return <PageError>Model &quot;{modelName}&quot; not found</PageError>
    return <EditView model={model} onNavigate={onNavigate} />
  }

  const versionMatch = path.match(/^\/collections\/([^/]+)\/([^/]+)\/versions$/)
  if (versionMatch) {
    const modelName = versionMatch[1]!
    const recordId = versionMatch[2]!
    const model = config.models.find((m) => m.name === modelName)
    if (!model) return <PageError>Model &quot;{modelName}&quot; not found</PageError>
    return <VersionHistory model={model} recordId={recordId} onNavigate={onNavigate} />
  }

  const editMatch = path.match(/^\/collections\/([^/]+)\/([^/]+)$/)
  if (editMatch) {
    const modelName = editMatch[1]!
    const recordId = editMatch[2]!
    const model = config.models.find((m) => m.name === modelName)
    if (!model) return <PageError>Model &quot;{modelName}&quot; not found</PageError>
    return <EditView model={model} recordId={recordId} onNavigate={onNavigate} />
  }

  const globalMatch = path.match(/^\/globals\/([^/]+)$/)
  if (globalMatch) {
    const globalName = globalMatch[1]!
    const globalConfig = config.globals.find((g) => g.name === globalName)
    if (!globalConfig) return <PageError>Global &quot;{globalName}&quot; not found</PageError>
    return <GlobalEditView global={globalConfig} />
  }

  if (path === "/dev/schema") return <SchemaView />
  if (path === "/dev/data") return <DataExplorer />
  if (path === "/dev/sql") return <SqlRunner />
  if (path === "/dev/migrations") return <MigrationHistory />
  if (path === "/dev/auth") return <AuthManagement />
  if (path === "/dev/storage") return <StorageBrowser />
  if (path === "/dev/api") return <ApiDocs />
  if (path === "/dev/logs") return <LogsViewer />
  if (path === "/dev/settings") return <Settings />

  return <PageError>Page not found: {path}</PageError>
}

function PageError({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="p-3 text-destructive bg-destructive/10 rounded-md text-sm">{children}</div>
}
