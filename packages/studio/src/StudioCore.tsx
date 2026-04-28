"use client"

import React, { useState, useEffect } from "react"
import { Routes, Route, Navigate, Outlet, useNavigate, useLocation, useParams } from "react-router-dom"
import type { StudioCoreProps } from "./types.js"
import { AdminConfigContext, useAdminConfig } from "./hooks/useAdminConfig.js"
import { AdminClientContext, useAdminClient } from "./hooks/useAdminClient.js"
import { LocaleContext, useLocaleState } from "./hooks/useLocale.js"
import { CloudUrlContext } from "./hooks/useCloudUrl.js"
import { PlatformCtx } from "./hooks/usePlatform.js"
import { Sidebar, getPageBreadcrumbs } from "./components/Sidebar.js"
import { SecondaryPanel } from "./components/SecondaryPanel.js"
import { TertiaryNav } from "./components/TertiaryNav.js"
import { TopBar } from "./components/TopBar.js"

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
import { StorageBrowser } from "./views/StorageBrowser.js"
import { ApiDocs } from "./views/ApiDocs.js"
import { RestApiSettings } from "./views/RestApiSettings.js"
import { GraphQLExplorer } from "./views/GraphQLExplorer.js"
import { GraphQLSettings } from "./views/GraphQLSettings.js"
import { ModelSchema } from "./views/ModelSchema.js"
import { ModelApiDocs } from "./views/ModelApiDocs.js"
import { ModelGraphQLDocs } from "./views/ModelGraphQLDocs.js"
import { LogsViewer } from "./views/LogsViewer.js"
import { Settings } from "./views/Settings.js"
import { ComingSoon } from "./views/ComingSoon.js"
import { EdgeFunctions } from "./views/EdgeFunctions.js"
import { RealtimeInspector } from "./views/RealtimeInspector.js"
import { PluginsMarketplace } from "./views/PluginsMarketplace.js"

// Database sub-pages
import { TablesView } from "./views/database/TablesView.js"
import { ViewsView } from "./views/database/ViewsView.js"
import { FunctionsView } from "./views/database/FunctionsView.js"
import { TriggersView } from "./views/database/TriggersView.js"
import { TypesView } from "./views/database/TypesView.js"
import { RolesView } from "./views/database/RolesView.js"
import { ExtensionsView } from "./views/database/ExtensionsView.js"

// Auth sub-pages
import { UsersView } from "./views/auth/UsersView.js"
import { PoliciesView } from "./views/auth/PoliciesView.js"
import { ProvidersView } from "./views/auth/ProvidersView.js"
import { ConfigurationView } from "./views/auth/ConfigurationView.js"
import { EmailTemplatesView } from "./views/auth/EmailTemplatesView.js"

// Storage sub-pages
import { StoragePoliciesView } from "./views/storage/PoliciesView.js"

// ─── Studio Layout ─────────────────────────────────────────────────────────────

interface StudioLayoutProps {
  extensions?: import("./types.js").StudioExtension | undefined
  demoMode?: boolean | undefined
}

function StudioLayout({ extensions, demoMode }: StudioLayoutProps): React.ReactElement {
  const location = useLocation()
  const configCtx = React.useContext(AdminConfigContext)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Close mobile sidebar on navigation
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  // Sync document.title with current route
  useEffect(() => {
    if (!configCtx) return
    const crumbs = getPageBreadcrumbs(location.pathname, configCtx)
    const appName = configCtx.branding?.appName ?? "Supatype Studio"
    document.title = [...crumbs, appName].join(" | ")
  }, [location.pathname, configCtx])

  if (!configCtx) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-muted-foreground text-sm">Loading project...</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-background overflow-hidden">
      {/* Full-width top bar */}
      <TopBar
        config={configCtx}
        leftItems={extensions?.topBarLeftItems}
        extraItems={extensions?.topBarItems}
        demoMode={demoMode}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
      />

      {/* 3-tier nav: primary icon sidebar + secondary panel + content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Tier 1: icon-only sidebar (hover-expands as overlay) */}
        <Sidebar
          config={configCtx}
          extraSections={extensions?.sidebarSections}
          className="hidden md:flex"
        />

        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <>
            <div
              className="fixed inset-0 bg-black/40 z-40 md:hidden"
              onClick={() => setSidebarOpen(false)}
            />
            <Sidebar
              config={configCtx}
              extraSections={extensions?.sidebarSections}
              className="fixed top-14 left-0 h-[calc(100vh-56px)] z-50 md:hidden"
            />
          </>
        )}

        {/* Tier 2: vertical secondary panel (section-specific items) */}
        <SecondaryPanel />

        {/* Tier 3 + content column */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Tier 3: horizontal tertiary nav (sub-items within a section item) */}
          <TertiaryNav />
          <main
            id="studio-main"
            className="flex-1 overflow-y-auto p-6 bg-[hsl(var(--canvas))]"
          >
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  )
}

// ─── Route Wrappers ────────────────────────────────────────────────────────────

function ModelsOverview(): React.ReactElement {
  const config = useAdminConfig()
  if (config.models.length > 0) {
    return <Navigate to={`/models/${config.models[0]!.name}`} replace />
  }
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center">
      <p className="text-muted-foreground text-sm">No models defined yet.</p>
      <p className="text-muted-foreground text-xs mt-1">Push your schema to create models.</p>
    </div>
  )
}

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

function CollectionSchemaRoute(): React.ReactElement {
  const config = useAdminConfig()
  const { model: modelName } = useParams()
  const model = config.models.find((m) => m.name === modelName)
  if (!model) return <PageError>Model &quot;{modelName}&quot; not found</PageError>
  return <ModelSchema model={model} />
}

function CollectionDataRoute(): React.ReactElement {
  const config = useAdminConfig()
  const { model: modelName } = useParams()
  const model = config.models.find((m) => m.name === modelName)
  if (!model) return <PageError>Model &quot;{modelName}&quot; not found</PageError>
  return <DataExplorer initialTable={model.tableName} />
}

function CollectionApiRoute(): React.ReactElement {
  const config = useAdminConfig()
  const { model: modelName } = useParams()
  const model = config.models.find((m) => m.name === modelName)
  if (!model) return <PageError>Model &quot;{modelName}&quot; not found</PageError>
  return <ModelApiDocs model={model} />
}

function CollectionGraphQLRoute(): React.ReactElement {
  const config = useAdminConfig()
  const { model: modelName } = useParams()
  const model = config.models.find((m) => m.name === modelName)
  if (!model) return <PageError>Model &quot;{modelName}&quot; not found</PageError>
  return <ModelGraphQLDocs model={model} />
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

// ─── StudioCore ────────────────────────────────────────────────────────────────

export function StudioCore({ config, client, extensions, demoMode, cloudUrl, platformUrl, projectRef }: StudioCoreProps): React.ReactElement {
  const localeState = useLocaleState(config)

  let content = (
    <CloudUrlContext.Provider value={cloudUrl}>
    <PlatformCtx.Provider value={{ platformUrl, projectRef }}>
    <AdminConfigContext.Provider value={config}>
      <AdminClientContext.Provider value={client}>
        <LocaleContext.Provider value={localeState}>
          <Routes>
            <Route element={<StudioLayout extensions={extensions} demoMode={demoMode} />}>
              {/* CMS */}
              <Route index element={<Dashboard />} />
              <Route path="media" element={<MediaLibrary />} />
              <Route path="models" element={<ModelsOverview />} />
              <Route path="models/:model" element={<CollectionListRoute />} />
              <Route path="models/:model/schema"  element={<CollectionSchemaRoute />} />
              <Route path="models/:model/data"    element={<CollectionDataRoute />} />
              <Route path="models/:model/api"     element={<CollectionApiRoute />} />
              <Route path="models/:model/graphql" element={<CollectionGraphQLRoute />} />
              <Route path="models/:model/create"  element={<CollectionCreateRoute />} />
              <Route path="models/:model/:recordId/versions" element={<CollectionVersionsRoute />} />
              <Route path="models/:model/:recordId" element={<CollectionEditRoute />} />
              <Route path="globals/:name" element={<GlobalRoute />} />

              {/* Developer tools — Database */}
              <Route path="database">
                <Route index element={<Navigate to="overview" replace />} />
                <Route path="overview"    element={<SchemaView />} />
                <Route path="tables"      element={<TablesView />} />
                <Route path="views"       element={<ViewsView />} />
                <Route path="functions"   element={<FunctionsView />} />
                <Route path="triggers"    element={<TriggersView />} />
                <Route path="types"       element={<TypesView />} />
                <Route path="roles"       element={<RolesView />} />
                <Route path="extensions"  element={<ExtensionsView />} />
                <Route path="sql"         element={<SqlRunner />} />
                <Route path="migrations"  element={<MigrationHistory />} />
                <Route path="wrappers"    element={<ComingSoon title="Database Wrappers" description="Connect to external data sources (Postgres FDW, S3, BigQuery, Stripe). Coming in Phase 26." />} />
                <Route path="replication" element={<ComingSoon title="Read Replicas" description="Cross-region read replicas, publication management, replication slot monitoring. Coming in Phase 27." />} />
                <Route path="warehouse"   element={<ComingSoon title="Analytical Warehouse" description="Columnar OLAP engine for analytics queries without impacting OLTP. Coming in Phase 28." />} />
                <Route path="backups"     element={<ComingSoon title="Backups" description="Point-in-time recovery and scheduled database backups." />} />
              </Route>
              <Route path="data" element={<DataExplorer />} />

              {/* Media & Storage */}
              <Route path="media-storage"           element={<StorageBrowser />} />
              <Route path="media-storage/policies"  element={<StoragePoliciesView />} />

              {/* Authentication */}
              <Route path="authentication" element={<Navigate to="/authentication/users" replace />} />
              <Route path="authentication/users"           element={<UsersView />} />
              <Route path="authentication/policies"        element={<PoliciesView />} />
              <Route path="authentication/providers"       element={<ProvidersView />} />
              <Route path="authentication/configuration"   element={<ConfigurationView />} />
              <Route path="authentication/email-templates" element={<EmailTemplatesView />} />
              <Route path="authentication/hooks"    element={<ComingSoon title="Auth Hooks" description="Configure pre/post hooks for auth events. Coming in Phase 11." />} />
              <Route path="authentication/sso"      element={<ComingSoon title="SSO & OAuth Clients" description="SAML 2.0, OIDC, and OAuth2 client management. Coming in Phase 11." />} />
              <Route path="authentication/security" element={<ComingSoon title="Attack Protection" description="CAPTCHA, IP blocking, leaked password detection, rate limits. Coming in Phase 14." />} />

              {/* Observability (Logs + Metrics + Advisors) */}
              <Route path="observability">
                <Route index element={<Navigate to="logs" replace />} />
                <Route path="logs" element={<Navigate to="api" replace />} />
                <Route path="logs/api"       element={<LogsViewer />} />
                <Route path="logs/auth"      element={<ComingSoon title="Auth Logs" description="Auth event logging coming in Phase 30." />} />
                <Route path="logs/storage"   element={<ComingSoon title="Storage Logs" description="Storage access logging coming in Phase 30." />} />
                <Route path="logs/functions" element={<ComingSoon title="Edge Function Logs" description="Real-time function log streaming coming in Phase 30." />} />
                <Route path="logs/realtime"  element={<ComingSoon title="Realtime Logs" description="Realtime connection logs coming in Phase 30." />} />
                <Route path="logs/postgres"  element={<ComingSoon title="Postgres Logs" description="Database server logs coming in Phase 30." />} />
                <Route path="metrics"   element={<ComingSoon title="Metrics" description="Metrics, traces, and alerts for your database and API infrastructure. Coming in Phase 30." />} />
                <Route path="advisors"  element={<ComingSoon title="Advisors" description="Performance, security, and schema recommendations powered by your live database. Coming in Phase 29." />} />
              </Route>

              {/* Legacy log/advisor/observability redirects */}
              <Route path="logs" element={<Navigate to="/observability/logs" replace />} />
              <Route path="logs/api"       element={<Navigate to="/observability/logs/api"       replace />} />
              <Route path="logs/auth"      element={<Navigate to="/observability/logs/auth"      replace />} />
              <Route path="logs/storage"   element={<Navigate to="/observability/logs/storage"   replace />} />
              <Route path="logs/functions" element={<Navigate to="/observability/logs/functions" replace />} />
              <Route path="logs/realtime"  element={<Navigate to="/observability/logs/realtime"  replace />} />
              <Route path="logs/postgres"  element={<Navigate to="/observability/logs/postgres"  replace />} />

              {/* Settings */}
              <Route path="settings"       element={<Settings />} />

              {/* Platform features */}
              <Route path="email"          element={<ComingSoon title="Email" description="Configure transactional email providers, templates, and delivery settings." />} />
              <Route path="edge-functions" element={<EdgeFunctions />} />
              <Route path="realtime"       element={<RealtimeInspector />} />
              <Route path="plugins"        element={<PluginsMarketplace />} />
              <Route path="webhooks"       element={<ComingSoon title="Webhooks" description="Schema-driven webhooks that fire on record create/update/delete. Configure endpoints, retry policies, and delivery history. Coming in Phase 17." />} />
              <Route path="jobs"           element={<ComingSoon title="Scheduled Jobs" description="Cron-scheduled SQL jobs and edge function invocations. View execution history and trigger manually. Coming in Phase 18." />} />

              {/* Intelligence (AI & Agents) */}
              <Route path="ai" element={<Navigate to="/ai/usage" replace />} />
              <Route path="ai/usage"   element={<ComingSoon title="AI Usage" description="Track AI call volume, feature breakdown, and spending caps across schema generation, migration copilot, content assist, and RAG. Coming in Phase 15." />} />
              <Route path="ai/vectors" element={<ComingSoon title="Vector Management" description="Embedding browser, similarity search tester, index management, and vector space visualisation. Coming in Phase 15." />} />
              <Route path="ai/rag"     element={<ComingSoon title="RAG Pipeline" description="Schema-declared retrieval-augmented generation. Embed content from any model's fields, search by semantic meaning, and ground LLM answers in your real data — with RLS enforced automatically. Coming in Phase 15." />} />
              <Route path="ai/agents" element={<Navigate to="/ai/agents/list" replace />} />
              <Route path="ai/agents/list"       element={<ComingSoon title="Agents" description="Declare LLM agents in your schema with tools, access rules, and triggers. Platform agents run on schedules or database events. User-facing agents are callable via the SDK. Coming in Phase 18.5." />} />
              <Route path="ai/agents/runs"       element={<ComingSoon title="Agent Run History" description="Step-by-step tool call history for every agent run — trigger source, cost estimate, injection detection alerts, and full conversation archive. Coming in Phase 18.5." />} />
              <Route path="ai/agents/playground" element={<ComingSoon title="Agent Playground" description="Run any declared agent from Studio with a custom input. Streams tool calls and the final answer in real time. Coming in Phase 18.5." />} />

              {/* Commerce, Analytics, Branching, Integrations */}
              <Route path="commerce"     element={<ComingSoon title="Commerce" description="Order management, subscription billing, Stripe Connect payouts, and revenue analytics. Coming in Phase 16." />} />
              <Route path="analytics"    element={<ComingSoon title="Analytics" description="Auto-generated dashboards from your schema — KPI cards, time-series charts, and CSV export. Coming in Phase 21." />} />
              <Route path="branching"    element={<ComingSoon title="Branching & Environments" description="Schema-aware preview environments, branch diff view, and one-click merge. Coming in Phase 22." />} />
              <Route path="integrations" element={<ComingSoon title="Integrations" description="Connect GitHub for CI/CD deployments and Vercel for preview environment sync. Coming in Phase 25." />} />
              <Route path="audit"        element={<ComingSoon title="Audit Log" description="Immutable log of all data changes with before/after snapshots and user attribution. Coming in Phase 13." />} />

              {/* Legacy observability/advisor redirects */}
              <Route path="advisors"      element={<Navigate to="/observability/advisors"  replace />} />

              {/* API section */}
              <Route path="api" element={<Navigate to="/api/rest" replace />} />
              <Route path="api/rest" element={<ApiDocs />} />
              <Route path="api/rest/settings" element={<RestApiSettings />} />
              <Route path="api/graphql" element={<GraphQLExplorer />} />
              <Route path="api/graphql/settings" element={<GraphQLSettings />} />

              {/* Legacy / redirect paths */}
              <Route path="schema"             element={<Navigate to="/database/overview"   replace />} />
              <Route path="migrations"         element={<Navigate to="/database/migrations" replace />} />
              <Route path="api-docs"           element={<Navigate to="/api/rest"            replace />} />
              <Route path="dev/sql"            element={<Navigate to="/database/sql"        replace />} />
              <Route path="dev/storage"        element={<Navigate to="/media-storage"       replace />} />
              <Route path="dev/auth"           element={<Navigate to="/authentication"      replace />} />
              <Route path="dev/functions"      element={<Navigate to="/edge-functions"      replace />} />
              <Route path="dev/api"            element={<Navigate to="/api/rest"            replace />} />
              <Route path="dev/database"       element={<Navigate to="/database/sql"        replace />} />
              <Route path="dev/media-storage"  element={<Navigate to="/media-storage"       replace />} />
              <Route path="dev/authentication" element={<Navigate to="/authentication"      replace />} />
              <Route path="dev/edge-functions" element={<Navigate to="/edge-functions"      replace />} />
              <Route path="dev/api-docs"       element={<Navigate to="/api/rest"            replace />} />
              <Route path="dev/realtime"       element={<Navigate to="/realtime"            replace />} />
              <Route path="dev/plugins"        element={<Navigate to="/plugins"             replace />} />
              <Route path="dev/advisors"       element={<Navigate to="/observability/advisors" replace />} />
              <Route path="dev/observability"  element={<Navigate to="/observability/metrics"  replace />} />
              <Route path="dev/logs"           element={<Navigate to="/observability/logs"     replace />} />
              <Route path="dev/settings"       element={<Navigate to="/settings"            replace />} />
              <Route path="dev/email"          element={<Navigate to="/email"               replace />} />
              <Route path="dev/schema"         element={<Navigate to="/database/overview"   replace />} />
              <Route path="dev/data"           element={<Navigate to="/data"                replace />} />
              <Route path="dev/migrations"     element={<Navigate to="/database/migrations" replace />} />

              {/* Extension routes */}
              {extensions?.routes?.map((r) => {
                // Cast required: studio uses @types/react@19, react-router-dom ships @types/react@18
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const el = r.element as any
                return <Route key={r.path} path={r.path} element={el} />
              })}

              {/* 404 */}
              <Route path="*" element={<PageError>Page not found</PageError>} />
            </Route>
          </Routes>
        </LocaleContext.Provider>
      </AdminClientContext.Provider>
    </AdminConfigContext.Provider>
    </PlatformCtx.Provider>
    </CloudUrlContext.Provider>
  )

  if (extensions?.providers) {
    for (let i = extensions.providers.length - 1; i >= 0; i--) {
      const Provider = extensions.providers[i]!
      content = <Provider>{content}</Provider>
    }
  }

  return content
}

function PageError({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="p-3 text-destructive bg-destructive/10 rounded-md text-sm">{children}</div>
}
