import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react"
import type { AdminConfig } from "../config.js"
import { createClient, type SupatypeClient } from "@supatype/client"

// ─── Types ──────────────────────────────────────────────────────────────────────

export type ProjectStatus = "provisioning" | "active" | "paused" | "error" | "deleting"
export type Tier = "free" | "pro" | "team" | "enterprise"

export interface CloudProject {
  id: string
  orgId: string
  name: string
  slug: string
  tier: Tier
  region: string
  status: ProjectStatus
  lastActivityAt: string
  pausedAt: string | null
  dbSizeMb: number
  storageSizeMb: number
  bandwidthUsedMb: number
  apiRequestCount: number
  createdAt: string
  updatedAt: string
}

export interface CloudOrganisation {
  id: string
  name: string
  tier: Tier
  role: string
  ownerUserId: string
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  createdAt: string
  updatedAt: string
}

export interface CloudEnvironment {
  id: string
  projectId: string
  name: string
  apiUrl: string
  anonKey: string
  serviceRoleKey: string
  createdAt: string
}

export interface CloudFeatures {
  projectList: boolean
  projectSwitcher: boolean
  billing: boolean
  environments: boolean
  usage: boolean
  domains: boolean
  orgSettings: boolean
}

export interface CloudDomain {
  id: string
  domain: string
  cnameTarget: string
  status: string
  sslExpiresAt: string | null
  lastVerifiedAt: string | null
  createdAt: string
}

export interface CloudApiKey {
  id: string
  environmentId: string
  environmentName: string
  role: "anon" | "service_role"
  keyPrefix: string
  createdAt: string
}

export interface CloudMember {
  id: string
  userId: string
  email: string
  name: string
  role: string
  createdAt: string
}

export interface CloudState {
  mode: "cloud" | "self-hosted"
  features: CloudFeatures
  // Organisations
  organisations: CloudOrganisation[]
  activeOrg: CloudOrganisation | null
  setActiveOrg: (org: CloudOrganisation | null) => void
  createOrganisation: (name: string) => Promise<CloudOrganisation>
  refreshOrganisations: () => Promise<void>
  // Projects
  projects: CloudProject[]
  activeProject: CloudProject | null
  activeEnvironment: string
  setActiveProject: (project: CloudProject | null) => void
  setActiveEnvironment: (env: string) => void
  refreshProjects: () => Promise<void>
  createProject: (name: string, tier?: Tier, region?: string) => Promise<CloudProject>
  pauseProject: (slug: string) => Promise<void>
  resumeProject: (slug: string) => Promise<void>
  deleteProject: (slug: string, confirmation: string) => Promise<void>
  retryProject: (slug: string) => Promise<void>
  // Domain management
  listDomains: (slug: string) => Promise<CloudDomain[]>
  addDomain: (slug: string, domain: string) => Promise<CloudDomain>
  verifyDomain: (slug: string, domainId: string) => Promise<CloudDomain>
  removeDomain: (slug: string, domainId: string) => Promise<void>
  // Organisation management
  updateOrganisation: (orgId: string, name: string) => Promise<void>
  getBillingPortalUrl: (returnUrl: string) => Promise<string>
  listMembers: (orgId: string) => Promise<CloudMember[]>
  inviteMember: (orgId: string, email: string, role?: string) => Promise<void>
  removeMember: (orgId: string, userId: string) => Promise<void>
  // Billing
  subscribe: (tier: "pro" | "team") => Promise<{ subscriptionId: string; clientSecret: string | null }>
  cancelSubscription: () => Promise<void>
  // API keys
  listApiKeys: (slug: string) => Promise<CloudApiKey[]>
  getEnvironments: (slug: string) => Promise<CloudEnvironment[]>
  // Live project state — populated when activeProject is set
  projectConfig: AdminConfig | null
  projectClient: SupatypeClient | null
  projectEnvironments: CloudEnvironment[]
  projectConfigLoading: boolean
  // State
  loading: boolean
  error: string | null
}

const SELF_HOSTED_STATE: CloudState = {
  mode: "self-hosted",
  features: {
    projectList: false,
    projectSwitcher: false,
    billing: false,
    environments: false,
    usage: false,
    domains: false,
    orgSettings: false,
  },
  organisations: [],
  activeOrg: null,
  setActiveOrg: () => {},
  createOrganisation: async () => { throw new Error("Not available in self-hosted mode") },
  refreshOrganisations: async () => {},
  projects: [],
  activeProject: null,
  activeEnvironment: "production",
  setActiveProject: () => {},
  setActiveEnvironment: () => {},
  refreshProjects: async () => {},
  createProject: async () => { throw new Error("Not available in self-hosted mode") },
  pauseProject: async () => {},
  resumeProject: async () => {},
  deleteProject: async () => {},
  retryProject: async () => {},
  listDomains: async () => [],
  addDomain: async () => { throw new Error("Not available in self-hosted mode") },
  verifyDomain: async () => { throw new Error("Not available in self-hosted mode") },
  removeDomain: async () => {},
  updateOrganisation: async () => {},
  getBillingPortalUrl: async () => { throw new Error("Not available in self-hosted mode") },
  listMembers: async () => [],
  inviteMember: async () => {},
  removeMember: async () => {},
  subscribe: async () => { throw new Error("Not available in self-hosted mode") },
  cancelSubscription: async () => { throw new Error("Not available in self-hosted mode") },
  listApiKeys: async () => [],
  getEnvironments: async () => [],
  projectConfig: null,
  projectClient: null,
  projectEnvironments: [],
  projectConfigLoading: false,
  loading: false,
  error: null,
}

// ─── Context ────────────────────────────────────────────────────────────────────

export const CloudContext = createContext<CloudState>(SELF_HOSTED_STATE)

export function useCloud(): CloudState {
  return useContext(CloudContext)
}

// ─── Hook to build cloud state ─────────────────────────────────────────────────

export function useCloudState(controlPlaneUrl: string | undefined, token: string | undefined): CloudState {
  const [mode, setMode] = useState<"cloud" | "self-hosted">("self-hosted")
  const [features, setFeatures] = useState<CloudFeatures>(SELF_HOSTED_STATE.features)
  const [organisations, setOrganisations] = useState<CloudOrganisation[]>([])
  const [activeOrg, setActiveOrgState] = useState<CloudOrganisation | null>(null)
  const [projects, setProjects] = useState<CloudProject[]>([])
  const [activeProject, setActiveProject] = useState<CloudProject | null>(null)
  const [activeEnvironment, setActiveEnvironment] = useState("production")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ─── Refs for values callbacks need to read without depending on ─────────────
  // These let useCallback closures access current state without re-creating.
  const activeOrgRef = useRef(activeOrg)
  const activeProjectRef = useRef(activeProject)
  useEffect(() => { activeOrgRef.current = activeOrg }, [activeOrg])
  useEffect(() => { activeProjectRef.current = activeProject }, [activeProject])

  // ─── Stable API call helper ─────────────────────────────────────────────────
  // Read activeOrg from ref so this callback doesn't change when org changes.
  const apiCall = useCallback(async <T>(method: string, path: string, body?: unknown, orgOverride?: string): Promise<T> => {
    if (!controlPlaneUrl || !token) throw new Error("Not connected to cloud")
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    }
    const orgId = orgOverride ?? activeOrgRef.current?.id
    if (orgId) {
      headers["X-Org-Id"] = orgId
    }
    const res = await fetch(`${controlPlaneUrl}/api/v1${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const json = await res.json() as { data?: T; error?: string; message?: string }
    if (!res.ok) throw new Error(json.message ?? json.error ?? "API error")
    return json.data as T
  }, [controlPlaneUrl, token])

  // Detect mode on mount
  useEffect(() => {
    if (!controlPlaneUrl) {
      setMode("self-hosted")
      return
    }

    fetch(`${controlPlaneUrl}/api/v1/studio/mode`)
      .then((res) => res.json() as Promise<{ data: { mode: string; features: CloudFeatures } }>)
      .then((json) => {
        if (json.data.mode === "cloud") {
          setMode("cloud")
          setFeatures(json.data.features)
        }
      })
      .catch(() => {
        setMode("self-hosted")
      })
  }, [controlPlaneUrl])

  // ─── Organisation management ──────────────────────────────────────────────────

  const refreshOrganisations = useCallback(async () => {
    if (mode !== "cloud") return
    try {
      const orgs = await apiCall<CloudOrganisation[]>("GET", "/organisations")
      setOrganisations(orgs)

      // Restore active org from localStorage, or pick first
      if (!activeOrgRef.current) {
        const savedOrgId = typeof localStorage !== "undefined" ? localStorage.getItem("supatype_active_org") : null
        const restored = savedOrgId ? orgs.find((o) => o.id === savedOrgId) : null
        if (restored) {
          setActiveOrgState(restored)
        } else if (orgs.length > 0) {
          setActiveOrgState(orgs[0]!)
          if (typeof localStorage !== "undefined") localStorage.setItem("supatype_active_org", orgs[0]!.id)
        }
      }
    } catch (err) {
      console.error("[cloud] Failed to load organisations:", err)
    }
  }, [mode, apiCall])

  const setActiveOrg = useCallback((org: CloudOrganisation | null) => {
    setActiveOrgState(org)
    if (org && typeof localStorage !== "undefined") {
      localStorage.setItem("supatype_active_org", org.id)
    }
    // Clear projects when switching org — they'll be reloaded
    setProjects([])
    setActiveProject(null)
  }, [])

  const createOrganisation = useCallback(async (name: string): Promise<CloudOrganisation> => {
    const org = await apiCall<CloudOrganisation>("POST", "/organisations", { name })
    await refreshOrganisations()
    return org
  }, [apiCall, refreshOrganisations])

  // Load orgs when cloud mode is detected
  useEffect(() => {
    if (mode === "cloud" && token) {
      void refreshOrganisations()
    }
  }, [mode, token, refreshOrganisations])

  // ─── Project management ───────────────────────────────────────────────────────

  const refreshProjects = useCallback(async () => {
    if (mode !== "cloud" || !activeOrgRef.current) return
    setLoading(true)
    setError(null)
    try {
      const result = await apiCall<CloudProject[]>("GET", "/projects")
      setProjects(result)

      // Restore active project from localStorage
      if (!activeProjectRef.current) {
        const savedSlug = typeof localStorage !== "undefined" ? localStorage.getItem("supatype_active_project") : null
        if (savedSlug) {
          const saved = result.find((p) => p.slug === savedSlug)
          if (saved) setActiveProject(saved)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects")
    } finally {
      setLoading(false)
    }
  }, [mode, apiCall])

  // Reload projects when active org changes
  useEffect(() => {
    if (mode === "cloud" && token && activeOrg) {
      void refreshProjects()
    }
  }, [mode, token, activeOrg?.id, refreshProjects])

  const handleSetActiveProject = useCallback((project: CloudProject | null) => {
    setActiveProject(project)
    if (project && typeof localStorage !== "undefined") {
      localStorage.setItem("supatype_active_project", project.slug)
    }
  }, [])

  const createProject = useCallback(async (name: string, tier?: Tier, region?: string): Promise<CloudProject> => {
    const project = await apiCall<CloudProject>("POST", "/projects", { name, ...(tier !== undefined && { tier }), ...(region !== undefined && { region }) })
    await refreshProjects()
    return project
  }, [apiCall, refreshProjects])

  const pauseProject = useCallback(async (slug: string) => {
    await apiCall<unknown>("POST", `/projects/${slug}/pause`)
    await refreshProjects()
  }, [apiCall, refreshProjects])

  const resumeProject = useCallback(async (slug: string) => {
    await apiCall<unknown>("POST", `/projects/${slug}/resume`)
    await refreshProjects()
  }, [apiCall, refreshProjects])

  const deleteProject = useCallback(async (slug: string, confirmation: string) => {
    await apiCall<unknown>("DELETE", `/projects/${slug}`, { confirmation })
    if (activeProjectRef.current?.slug === slug) setActiveProject(null)
    await refreshProjects()
  }, [apiCall, refreshProjects])

  const retryProject = useCallback(async (slug: string) => {
    await apiCall<unknown>("POST", `/projects/${slug}/retry`)
    await refreshProjects()
  }, [apiCall, refreshProjects])

  // ─── Live project state (config + client from environments) ──────────────────

  const [projectConfig, setProjectConfig] = useState<AdminConfig | null>(null)
  const [projectEnvironments, setProjectEnvironments] = useState<CloudEnvironment[]>([])
  const [projectConfigLoading, setProjectConfigLoading] = useState(false)

  // When activeProject changes, fetch its config + environments
  useEffect(() => {
    if (mode !== "cloud" || !activeProject) {
      setProjectConfig(null)
      setProjectEnvironments([])
      return
    }

    let cancelled = false
    setProjectConfigLoading(true)

    Promise.all([
      apiCall<AdminConfig>("GET", `/projects/${activeProject.slug}/config`),
      apiCall<CloudEnvironment[]>("GET", `/projects/${activeProject.slug}/environments`),
    ])
      .then(([config, envs]) => {
        if (cancelled) return
        setProjectConfig(config)
        setProjectEnvironments(envs)
      })
      .catch((err) => {
        if (cancelled) return
        console.error("[cloud] Failed to load project config/environments:", err)
        setProjectConfig(null)
        setProjectEnvironments([])
      })
      .finally(() => {
        if (!cancelled) setProjectConfigLoading(false)
      })

    return () => { cancelled = true }
  }, [mode, activeProject?.slug, apiCall])

  // Build a real SupatypeClient from the selected environment
  const projectClient = useMemo<SupatypeClient | null>(() => {
    if (!activeProject) return null

    if (controlPlaneUrl && token) {
      // Cloud mode: route through control plane proxy
      return createClient({
        url: `${controlPlaneUrl}/api/v1/projects/${activeProject.slug}/proxy`,
        anonKey: token,
      })
    }

    // Self-hosted: direct connection to project services
    if (!projectEnvironments.length) return null
    const env = projectEnvironments.find((e) => e.name === activeEnvironment)
      ?? projectEnvironments.find((e) => e.name === "production")
      ?? projectEnvironments[0]
    if (!env) return null
    return createClient({ url: env.apiUrl, anonKey: env.anonKey })
  }, [activeProject, controlPlaneUrl, token, projectEnvironments, activeEnvironment])

  // ─── Domain management ────────────────────────────────────────────────────────

  const listDomains = useCallback(async (slug: string): Promise<CloudDomain[]> => {
    return apiCall<CloudDomain[]>("GET", `/projects/${slug}/domains`)
  }, [apiCall])

  const addDomain = useCallback(async (slug: string, domain: string): Promise<CloudDomain> => {
    return apiCall<CloudDomain>("POST", `/projects/${slug}/domains`, { domain })
  }, [apiCall])

  const verifyDomain = useCallback(async (slug: string, domainId: string): Promise<CloudDomain> => {
    return apiCall<CloudDomain>("POST", `/projects/${slug}/domains/${domainId}/verify`)
  }, [apiCall])

  const removeDomain = useCallback(async (slug: string, domainId: string) => {
    await apiCall<unknown>("DELETE", `/projects/${slug}/domains/${domainId}`)
  }, [apiCall])

  // ─── Organisation settings ────────────────────────────────────────────────────

  const updateOrganisation = useCallback(async (orgId: string, name: string) => {
    await apiCall<CloudOrganisation>("PUT", `/organisations/${orgId}`, { name })
    await refreshOrganisations()
  }, [apiCall, refreshOrganisations])

  const getBillingPortalUrl = useCallback(async (returnUrl: string): Promise<string> => {
    const result = await apiCall<{ url: string }>("POST", "/billing/portal", { returnUrl })
    return result.url
  }, [apiCall])

  const listMembers = useCallback(async (orgId: string): Promise<CloudMember[]> => {
    return apiCall<CloudMember[]>("GET", `/organisations/${orgId}/members`)
  }, [apiCall])

  const inviteMember = useCallback(async (orgId: string, email: string, role?: string) => {
    await apiCall<unknown>("POST", `/organisations/${orgId}/members`, { email, ...(role !== undefined && { role }) })
  }, [apiCall])

  const removeMember = useCallback(async (orgId: string, userId: string) => {
    await apiCall<unknown>("DELETE", `/organisations/${orgId}/members/${userId}`)
  }, [apiCall])

  // ─── Billing ──────────────────────────────────────────────────────────────────

  const subscribe = useCallback(async (tier: "pro" | "team"): Promise<{ subscriptionId: string; clientSecret: string | null }> => {
    const result = await apiCall<{ subscriptionId: string; clientSecret: string | null }>("POST", "/billing/subscribe", { tier })
    await refreshOrganisations()
    return result
  }, [apiCall, refreshOrganisations])

  const cancelSubscription = useCallback(async () => {
    await apiCall<unknown>("POST", "/billing/cancel")
    await refreshOrganisations()
    await refreshProjects()
  }, [apiCall, refreshOrganisations, refreshProjects])

  // ─── API keys ─────────────────────────────────────────────────────────────────

  const listApiKeys = useCallback(async (slug: string): Promise<CloudApiKey[]> => {
    return apiCall<CloudApiKey[]>("GET", `/projects/${slug}/keys`)
  }, [apiCall])

  const getEnvironments = useCallback(async (slug: string): Promise<CloudEnvironment[]> => {
    return apiCall<CloudEnvironment[]>("GET", `/projects/${slug}/environments`)
  }, [apiCall])

  return useMemo<CloudState>(() => ({
    mode,
    features,
    organisations,
    activeOrg,
    setActiveOrg,
    createOrganisation,
    refreshOrganisations,
    projects,
    activeProject,
    activeEnvironment,
    loading,
    error,
    setActiveProject: handleSetActiveProject,
    setActiveEnvironment,
    refreshProjects,
    createProject,
    pauseProject,
    resumeProject,
    deleteProject,
    retryProject,
    listDomains,
    addDomain,
    verifyDomain,
    removeDomain,
    updateOrganisation,
    getBillingPortalUrl,
    subscribe,
    cancelSubscription,
    listMembers,
    inviteMember,
    removeMember,
    listApiKeys,
    getEnvironments,
    projectConfig,
    projectClient,
    projectEnvironments,
    projectConfigLoading,
  }), [
    mode, features, organisations, activeOrg, projects, activeProject,
    activeEnvironment, loading, error, projectConfig, projectClient,
    projectEnvironments, projectConfigLoading,
    // Stable callbacks (won't trigger re-memo on their own):
    setActiveOrg, createOrganisation, refreshOrganisations,
    handleSetActiveProject, setActiveEnvironment, refreshProjects,
    createProject, pauseProject, resumeProject, deleteProject, retryProject,
    listDomains, addDomain, verifyDomain, removeDomain,
    updateOrganisation, getBillingPortalUrl, subscribe, cancelSubscription,
    listMembers, inviteMember, removeMember, listApiKeys, getEnvironments,
  ])
}
