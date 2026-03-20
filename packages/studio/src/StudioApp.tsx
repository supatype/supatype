import React, { useState, useEffect } from "react"
import { Routes, Route, Outlet, useNavigate, useLocation, useParams } from "react-router-dom"
import type { SupatypeClient } from "@supatype/client"
import type { AdminConfig } from "./config.js"
import { AdminConfigContext, useAdminConfig } from "./hooks/useAdminConfig.js"
import { AdminClientContext, useAdminClient } from "./hooks/useAdminClient.js"
import { LocaleContext, useLocaleState } from "./hooks/useLocale.js"
import { CloudContext, useCloudState, useCloud } from "./hooks/useCloud.js"
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

// Cloud views
import { ProjectList } from "./views/ProjectList.js"
import { CreateProject } from "./views/CreateProject.js"
import { UsageDashboard } from "./views/UsageDashboard.js"
import { OrgSettings } from "./views/OrgSettings.js"
import { DomainManagement } from "./views/DomainManagement.js"
import { ProjectSettings } from "./views/ProjectSettings.js"
import { DeploymentHistory } from "./views/DeploymentHistory.js"
import { AuditLog } from "./views/AuditLog.js"
import { BillingPage } from "./views/BillingPage.js"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StudioAppProps {
  /** Config for self-hosted mode. In cloud mode, derived from the active project. */
  config?: AdminConfig | undefined
  /** Client for self-hosted mode. In cloud mode, derived from the active project's environment. */
  client?: SupatypeClient | undefined
  controlPlaneUrl?: string | undefined
  cloudToken?: string | undefined
}

// ─── Cloud Guard ──────────────────────────────────────────────────────────────

function CloudGuard(): React.ReactElement {
  const cloud = useCloud()
  const location = useLocation()
  const navigate = useNavigate()

  const shouldRedirect = cloud.mode === "cloud"
    && (!cloud.activeOrg || !cloud.activeProject)
    && !location.pathname.startsWith("/cloud")

  React.useEffect(() => {
    if (shouldRedirect) {
      navigate("/cloud/projects", { replace: true })
    }
  }, [shouldRedirect, navigate])

  if (shouldRedirect) return <></>

  return <Outlet />
}

// ─── Studio Layout ────────────────────────────────────────────────────────────

function StudioLayout(): React.ReactElement {
  const location = useLocation()
  const cloud = useCloud()
  const configCtx = React.useContext(AdminConfigContext)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mode, setMode] = useState<StudioMode>("content")

  // Auto-switch mode based on route
  useEffect(() => {
    if (location.pathname.startsWith("/dev")) setMode("developer")
    else if (!location.pathname.startsWith("/cloud")) setMode("content")
  }, [location.pathname])

  // Close mobile sidebar on navigation
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  const hideSidebar = location.pathname === "/cloud/projects" || location.pathname === "/cloud/projects/create"
  const isCloudRoute = location.pathname.startsWith("/cloud")

  // Prevent CMS views from rendering without a config (avoids useAdminConfig throw)
  if (!configCtx && !isCloudRoute) {
    if (cloud.projectConfigLoading || cloud.mode !== "cloud") {
      return (
        <div className="flex items-center justify-center h-screen bg-background">
          <div className="text-muted-foreground text-sm">Loading project...</div>
        </div>
      )
    }
    if (cloud.activeProject) {
      return (
        <div className="flex items-center justify-center h-screen bg-background">
          <div className="text-muted-foreground text-sm">No schema config found. Deploy your schema with <code className="text-foreground">supatype push</code> first.</div>
        </div>
      )
    }
  }

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {!hideSidebar && configCtx && (
        <>
          <Sidebar
            config={configCtx}
            mode={mode}
            onModeChange={setMode}
            collapsed={sidebarCollapsed}
            onCollapsedChange={setSidebarCollapsed}
            className="hidden md:flex"
          />
          {sidebarOpen && (
            <>
              <div
                className="fixed inset-0 bg-black/40 z-40 md:hidden"
                onClick={() => setSidebarOpen(false)}
              />
              <Sidebar
                config={configCtx}
                mode={mode}
                onModeChange={setMode}
                collapsed={false}
                onCollapsedChange={setSidebarCollapsed}
                className="fixed top-0 left-0 h-screen z-50 md:hidden"
              />
            </>
          )}
        </>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          config={configCtx}
          mode={mode}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        />
        <main id="studio-main" className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

// ─── Route Wrappers ───────────────────────────────────────────────────────────

function CollectionListRoute(): React.ReactElement {
  const config = useAdminConfig()
  const { model: modelName } = useParams()
  const navigate = useNavigate()
  const model = config.models.find((m) => m.name === modelName)
  if (!model) return <PageError>Model &quot;{modelName}&quot; not found</PageError>
  return <ListView model={model} onNavigate={(p) => navigate(p)} />
}

function CollectionCreateRoute(): React.ReactElement {
  const config = useAdminConfig()
  const { model: modelName } = useParams()
  const navigate = useNavigate()
  const model = config.models.find((m) => m.name === modelName)
  if (!model) return <PageError>Model &quot;{modelName}&quot; not found</PageError>
  return <EditView model={model} onNavigate={(p) => navigate(p)} />
}

function CollectionEditRoute(): React.ReactElement {
  const config = useAdminConfig()
  const { model: modelName, recordId } = useParams()
  const navigate = useNavigate()
  const model = config.models.find((m) => m.name === modelName)
  if (!model || !recordId) return <PageError>Model &quot;{modelName}&quot; not found</PageError>
  return <EditView model={model} recordId={recordId} onNavigate={(p) => navigate(p)} />
}

function CollectionVersionsRoute(): React.ReactElement {
  const config = useAdminConfig()
  const { model: modelName, recordId } = useParams()
  const navigate = useNavigate()
  const model = config.models.find((m) => m.name === modelName)
  if (!model || !recordId) return <PageError>Model &quot;{modelName}&quot; not found</PageError>
  return <VersionHistory model={model} recordId={recordId} onNavigate={(p) => navigate(p)} />
}

function GlobalRoute(): React.ReactElement {
  const config = useAdminConfig()
  const { name } = useParams()
  const globalConfig = config.globals.find((g) => g.name === name)
  if (!globalConfig) return <PageError>Global &quot;{name}&quot; not found</PageError>
  return <GlobalEditView global={globalConfig} />
}

function ProjectListRoute(): React.ReactElement {
  const navigate = useNavigate()
  const cloud = useCloud()
  return (
    <ProjectList
      onNavigate={(p) => navigate(p)}
      onSelectProject={(project) => { cloud.setActiveProject(project); navigate("/") }}
      onCreateProject={() => navigate("/cloud/projects/create")}
    />
  )
}

function CreateProjectRoute(): React.ReactElement {
  const navigate = useNavigate()
  return (
    <CreateProject
      onNavigate={(p) => navigate(p)}
      onCreated={() => navigate("/cloud/projects")}
      onCancel={() => navigate("/cloud/projects")}
    />
  )
}

function ProjectSettingsRoute(): React.ReactElement {
  const navigate = useNavigate()
  return <ProjectSettings onNavigate={(p) => navigate(p)} />
}

function OrgSettingsRoute(): React.ReactElement {
  const navigate = useNavigate()
  return <OrgSettings onNavigate={(p) => navigate(p)} />
}

function BillingPageRoute(): React.ReactElement {
  const navigate = useNavigate()
  return <BillingPage onNavigate={(p) => navigate(p)} />
}

// ─── App ──────────────────────────────────────────────────────────────────────

export function StudioApp({ config: propConfig, client: propClient, controlPlaneUrl, cloudToken }: StudioAppProps): React.ReactElement {
  const cloudState = useCloudState(controlPlaneUrl, cloudToken)

  // In cloud mode, use config/client from the active project. In self-hosted, use props.
  const resolvedConfig = cloudState.projectConfig ?? propConfig ?? null
  const resolvedClient = cloudState.projectClient ?? propClient ?? null
  const localeState = useLocaleState(resolvedConfig)

  return (
    <CloudContext.Provider value={cloudState}>
      <AdminConfigContext.Provider value={resolvedConfig}>
        <AdminClientContext.Provider value={resolvedClient}>
          <LocaleContext.Provider value={localeState}>
            <Routes>
              <Route element={<CloudGuard />}>
                <Route element={<StudioLayout />}>
                  {/* CMS */}
                  <Route index element={<Dashboard />} />
                  <Route path="media" element={<MediaLibrary />} />
                  <Route path="collections/:model" element={<CollectionListRoute />} />
                  <Route path="collections/:model/create" element={<CollectionCreateRoute />} />
                  <Route path="collections/:model/:recordId/versions" element={<CollectionVersionsRoute />} />
                  <Route path="collections/:model/:recordId" element={<CollectionEditRoute />} />
                  <Route path="globals/:name" element={<GlobalRoute />} />

                  {/* Developer */}
                  <Route path="dev/schema" element={<SchemaView />} />
                  <Route path="dev/data" element={<DataExplorer />} />
                  <Route path="dev/sql" element={<SqlRunner />} />
                  <Route path="dev/migrations" element={<MigrationHistory />} />
                  <Route path="dev/auth" element={<AuthManagement />} />
                  <Route path="dev/storage" element={<StorageBrowser />} />
                  <Route path="dev/api" element={<ApiDocs />} />
                  <Route path="dev/logs" element={<LogsViewer />} />
                  <Route path="dev/settings" element={<Settings />} />

                  {/* Cloud */}
                  <Route path="cloud/projects" element={<ProjectListRoute />} />
                  <Route path="cloud/projects/create" element={<CreateProjectRoute />} />
                  <Route path="cloud/usage" element={<UsageDashboard />} />
                  <Route path="cloud/domains" element={<DomainManagement />} />
                  <Route path="cloud/settings" element={<ProjectSettingsRoute />} />
                  <Route path="cloud/org" element={<OrgSettingsRoute />} />
                  <Route path="cloud/deployments" element={<DeploymentHistory />} />
                  <Route path="cloud/audit" element={<AuditLog />} />
                  <Route path="cloud/billing" element={<BillingPageRoute />} />

                  {/* 404 */}
                  <Route path="*" element={<PageError>Page not found</PageError>} />
                </Route>
              </Route>
            </Routes>
          </LocaleContext.Provider>
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </CloudContext.Provider>
  )
}

function PageError({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="p-3 text-destructive bg-destructive/10 rounded-md text-sm">{children}</div>
}
