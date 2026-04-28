import React, { useState, useEffect, useCallback } from "react"
import { useCloud, type CloudDomain } from "../hooks/useCloud.js"
import { cn } from "../lib/utils.js"

const STATUS_COLORS: Record<string, string> = {
  pending_verification: "bg-amber-500/20 text-amber-400",
  verified: "bg-blue-500/20 text-blue-400",
  provisioning_ssl: "bg-blue-500/20 text-blue-400",
  active: "bg-emerald-500/20 text-emerald-400",
  ssl_failed: "bg-red-500/20 text-red-400",
  ssl_expiring: "bg-amber-500/20 text-amber-400",
}

export function DomainManagement(): React.ReactElement {
  const { activeProject, features, listDomains, addDomain, verifyDomain, removeDomain } = useCloud()
  const [domains, setDomains] = useState<CloudDomain[]>([])
  const [newDomain, setNewDomain] = useState("")
  const [adding, setAdding] = useState(false)
  const [verifying, setVerifying] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadDomains = useCallback(async () => {
    if (!activeProject) return
    try {
      const result = await listDomains(activeProject.slug)
      setDomains(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load domains")
    }
  }, [activeProject, listDomains])

  useEffect(() => {
    void loadDomains()
  }, [loadDomains])

  if (!features.domains || !activeProject) {
    return <div className="text-muted-foreground text-sm">Select a project to manage domains.</div>
  }

  const handleAddDomain = async () => {
    if (!newDomain.trim()) return
    setAdding(true)
    setError(null)
    try {
      await addDomain(activeProject.slug, newDomain.trim())
      setNewDomain("")
      await loadDomains()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add domain")
    } finally {
      setAdding(false)
    }
  }

  const handleVerify = async (domainId: string) => {
    setVerifying(domainId)
    setError(null)
    try {
      await verifyDomain(activeProject.slug, domainId)
      await loadDomains()
    } catch (err) {
      setError(err instanceof Error ? err.message : "CNAME verification failed")
    } finally {
      setVerifying(null)
    }
  }

  const handleRemove = async (domainId: string) => {
    setError(null)
    try {
      await removeDomain(activeProject.slug, domainId)
      await loadDomains()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove domain")
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Custom Domains</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Connect custom domains to <strong>{activeProject.name}</strong>
        </p>
      </div>

      {/* Default domain */}
      <div className="p-4 bg-card border border-border rounded-xl">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-foreground">Platform Domain</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Automatically assigned, always active</p>
          </div>
          <code className="text-sm text-primary bg-primary/10 px-2 py-1 rounded">
            {activeProject.slug}.supatype.dev
          </code>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-sm">{error}</div>
      )}

      {/* Add domain */}
      {activeProject.tier !== "free" && (
        <div className="flex gap-3">
          <input
            type="text"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="api.example.com"
            onKeyDown={(e) => { if (e.key === "Enter") void handleAddDomain() }}
            className="flex-1 max-w-md px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <button
            type="button"
            onClick={() => void handleAddDomain()}
            disabled={adding || !newDomain.trim()}
            className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {adding ? "Adding..." : "Add Domain"}
          </button>
        </div>
      )}

      {/* Domain list */}
      {domains.length > 0 && (
        <div className="space-y-3">
          {domains.map((domain) => (
            <div key={domain.id} className="p-4 bg-card border border-border rounded-xl">
              <div className="flex items-center justify-between mb-2">
                <code className="text-sm text-foreground">{domain.domain}</code>
                <div className="flex items-center gap-2">
                  <span className={cn("px-2 py-0.5 text-[11px] font-medium rounded-full", STATUS_COLORS[domain.status] ?? "bg-muted text-muted-foreground")}>
                    {domain.status.replace(/_/g, " ")}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleRemove(domain.id)}
                    className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>

              {domain.status === "pending_verification" && (
                <div className="p-3 bg-muted rounded-lg mt-2">
                  <p className="text-xs text-muted-foreground mb-1">Add a CNAME record:</p>
                  <div className="flex items-center gap-2 text-xs font-mono">
                    <span className="text-foreground">{domain.domain}</span>
                    <span className="text-muted-foreground">&rarr;</span>
                    <span className="text-primary">{domain.cnameTarget}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleVerify(domain.id)}
                    disabled={verifying === domain.id}
                    className="mt-2 px-3 py-1 text-xs font-medium bg-primary/10 text-primary rounded-md hover:bg-primary/20 disabled:opacity-50 transition-colors"
                  >
                    {verifying === domain.id ? "Verifying..." : "Verify CNAME"}
                  </button>
                </div>
              )}

              {domain.sslExpiresAt && (
                <div className="text-[11px] text-muted-foreground mt-2">
                  SSL expires: {new Date(domain.sslExpiresAt).toLocaleDateString()}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {domains.length === 0 && activeProject.tier === "free" && (
        <div className="p-8 text-center bg-card border border-border rounded-xl">
          <h3 className="text-sm font-medium text-foreground mb-2">Custom Domains</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Custom domains are available on Pro and Team plans.
          </p>
          <button
            type="button"
            className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            Upgrade to Pro
          </button>
        </div>
      )}
    </div>
  )
}
