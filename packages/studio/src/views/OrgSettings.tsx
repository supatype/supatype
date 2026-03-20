import React, { useState } from "react"
import { useCloud } from "../hooks/useCloud.js"

interface OrgSettingsProps {
  onNavigate: (path: string) => void
}

export function OrgSettings({ onNavigate }: OrgSettingsProps): React.ReactElement {
  const { activeOrg, updateOrganisation, getBillingPortalUrl, listMembers, inviteMember, removeMember } = useCloud()
  const [activeTab, setActiveTab] = useState<"general" | "billing" | "members">("general")
  const [orgName, setOrgName] = useState(activeOrg?.name ?? "")
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [billingLoading, setBillingLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Members state
  const [members, setMembers] = useState<Array<{ id: string; userId: string; email: string; name: string; role: string; createdAt: string }>>([])
  const [membersLoaded, setMembersLoaded] = useState(false)
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState("member")
  const [inviting, setInviting] = useState(false)

  if (!activeOrg) {
    return <div className="text-muted-foreground text-sm">Loading organisation...</div>
  }

  const hasSubscription = !!activeOrg.stripeSubscriptionId

  const handleSaveName = async () => {
    if (!orgName.trim() || orgName === activeOrg.name) return
    setSaving(true)
    setError(null)
    try {
      await updateOrganisation(activeOrg.id, orgName.trim())
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  const handleManageBilling = async () => {
    setBillingLoading(true)
    setError(null)
    try {
      const url = await getBillingPortalUrl(window.location.href)
      window.location.href = url
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open billing portal")
      setBillingLoading(false)
    }
  }

  const handleLoadMembers = async () => {
    if (membersLoaded) return
    try {
      const result = await listMembers(activeOrg.id)
      setMembers(result)
      setMembersLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load members")
    }
  }

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return
    setInviting(true)
    setError(null)
    try {
      await inviteMember(activeOrg.id, inviteEmail.trim(), inviteRole)
      setInviteEmail("")
      setMembersLoaded(false)
      await handleLoadMembers()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invite member")
    } finally {
      setInviting(false)
    }
  }

  const handleRemoveMember = async (userId: string) => {
    setError(null)
    try {
      await removeMember(activeOrg.id, userId)
      setMembers((prev) => prev.filter((m) => m.userId !== userId))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove member")
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Organisation Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">{activeOrg.name}</p>
      </div>

      {error && (
        <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-sm">{error}</div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border">
        {(["general", "billing", "members"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => {
              setActiveTab(tab)
              if (tab === "members") void handleLoadMembers()
            }}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "general" && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Organisation name</label>
            <div className="flex gap-3">
              <input
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void handleSaveName() }}
                className="w-full max-w-md px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <button
                type="button"
                onClick={() => void handleSaveName()}
                disabled={saving || !orgName.trim() || orgName === activeOrg.name}
                className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? "Saving..." : saved ? "Saved" : "Save"}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Plan</label>
            <div className="px-3 py-2 text-sm bg-muted rounded-lg text-foreground capitalize w-fit">
              {activeOrg.tier}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Your role</label>
            <div className="px-3 py-2 text-sm bg-muted rounded-lg text-foreground capitalize w-fit">
              {activeOrg.role}
            </div>
          </div>
        </div>
      )}

      {activeTab === "billing" && (
        <div className="space-y-4">
          <div className="p-4 bg-card border border-border rounded-xl">
            <h3 className="text-sm font-medium text-foreground mb-2">Current Plan</h3>
            <div className="text-2xl font-bold text-foreground capitalize mb-1">{activeOrg.tier}</div>
            <p className="text-xs text-muted-foreground">
              {hasSubscription
                ? "Active subscription via Stripe"
                : "No active subscription"}
            </p>
          </div>

          {hasSubscription && (
            <button
              type="button"
              onClick={() => void handleManageBilling()}
              disabled={billingLoading}
              className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
            >
              {billingLoading ? "Opening..." : "Manage billing in Stripe"}
            </button>
          )}

          {!hasSubscription && activeOrg.tier === "free" && (
            <button
              type="button"
              className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
            >
              Upgrade to Pro
            </button>
          )}
        </div>
      )}

      {activeTab === "members" && (
        <div className="space-y-4">
          {/* Invite form */}
          {(activeOrg.role === "owner" || activeOrg.role === "admin") && (
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="block text-sm font-medium text-foreground mb-1">Invite by email</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@example.com"
                  className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                className="px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="billing">Billing</option>
              </select>
              <button
                type="button"
                onClick={() => void handleInvite()}
                disabled={inviting || !inviteEmail.trim()}
                className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {inviting ? "Inviting..." : "Invite"}
              </button>
            </div>
          )}

          {/* Member list */}
          <div className="border border-border rounded-xl overflow-hidden">
            {members.length === 0 && !membersLoaded && (
              <div className="p-8 text-center text-muted-foreground text-sm">Loading members...</div>
            )}
            {members.length === 0 && membersLoaded && (
              <div className="p-8 text-center text-muted-foreground text-sm">No members found</div>
            )}
            {members.map((m) => (
              <div key={m.id} className="flex items-center justify-between px-4 py-3 border-b border-border last:border-b-0">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/20 text-primary text-xs font-semibold shrink-0">
                    {m.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-foreground">{m.name}</div>
                    <div className="text-xs text-muted-foreground">{m.email}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground capitalize px-2 py-0.5 bg-muted rounded">{m.role}</span>
                  {m.role !== "owner" && (activeOrg.role === "owner" || activeOrg.role === "admin") && (
                    <button
                      type="button"
                      onClick={() => void handleRemoveMember(m.userId)}
                      className="text-xs text-destructive hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
