import React, { useState, useEffect } from "react"
import { useStudioClient } from "../../StudioCore.js"
import { Button, Card } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { studioGatewayHeaders } from "../../lib/studio-gateway-headers.js"

const TEMPLATE_TYPES = [
  { id: "invite",        label: "Invite User" },
  { id: "confirmation",  label: "Signup" },
  { id: "recovery",      label: "Reset Password" },
  { id: "magiclink",     label: "Magic Link" },
  { id: "email_change",  label: "Email Change" },
] as const

type TemplateId = (typeof TEMPLATE_TYPES)[number]["id"]

const TEMPLATE_VARS: Record<TemplateId, string[]> = {
  invite: ["{{ .ConfirmationURL }}", "{{ .SiteURL }}", "{{ .Email }}", "{{ .InviterName }}"],
  confirmation: ["{{ .ConfirmationURL }}", "{{ .SiteURL }}", "{{ .Email }}", "{{ .Token }}"],
  recovery: ["{{ .ConfirmationURL }}", "{{ .SiteURL }}", "{{ .Email }}", "{{ .Token }}"],
  magiclink: ["{{ .ConfirmationURL }}", "{{ .SiteURL }}", "{{ .Email }}", "{{ .Token }}"],
  email_change: ["{{ .ConfirmationURL }}", "{{ .SiteURL }}", "{{ .Email }}", "{{ .NewEmail }}", "{{ .Token }}"],
}

export function EmailTemplatesView(): React.ReactElement {
  const client = useStudioClient()
  const [selected, setSelected] = useState<TemplateId>("confirmation")
  const [subject, setSubject] = useState("")
  const [content, setContent] = useState("")
  const [preview, setPreview] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`${client.url}/auth/v1/admin/template/${selected}`, {
      headers: {
        ...studioGatewayHeaders(),
        ...(client.serviceRoleKey && { Authorization: `Bearer ${client.serviceRoleKey}` }),
      },
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`)
        const json = (await res.json()) as { subject?: string; content?: string; body?: string }
        setSubject(json.subject ?? "")
        setContent(json.content ?? json.body ?? "")
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [client.url, client.serviceRoleKey, selected])

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`${client.url}/auth/v1/admin/template/${selected}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...studioGatewayHeaders(),
          ...(client.serviceRoleKey && { Authorization: `Bearer ${client.serviceRoleKey}` }),
        },
        credentials: "include",
        body: JSON.stringify({ subject, content }),
      })
      if (!res.ok) throw new Error(`Save failed: ${res.status}`)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex gap-4 h-full min-h-[600px]">
      {/* Template type list */}
      <div className="w-44 shrink-0">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">Templates</h2>
        <nav className="space-y-0.5">
          {TEMPLATE_TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSelected(t.id)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                selected === t.id
                  ? "bg-accent text-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Editor */}
      <div className="flex-1 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-foreground">
            {TEMPLATE_TYPES.find((t) => t.id === selected)?.label}
          </h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={`text-sm px-3 py-1 rounded-md transition-colors ${!preview ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
              onClick={() => setPreview(false)}
            >
              Edit
            </button>
            <button
              type="button"
              className={`text-sm px-3 py-1 rounded-md transition-colors ${preview ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
              onClick={() => setPreview(true)}
            >
              Preview
            </button>
          </div>
        </div>

        {error && <ErrorBanner message={error} />}

        {loading ? (
          <div className="space-y-2">
            <div className="h-8 rounded-md bg-muted animate-pulse" />
            <div className="h-48 rounded-md bg-muted animate-pulse" />
          </div>
        ) : preview ? (
          <Card className="p-4">
            <p className="text-xs text-muted-foreground mb-2">Subject: <strong className="text-foreground">{subject}</strong></p>
            <iframe
              title="email preview"
              srcDoc={content}
              className="w-full min-h-[400px] border border-border rounded-md bg-white"
              sandbox="allow-same-origin"
            />
          </Card>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Subject line</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Body (HTML)</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="w-full font-mono text-sm px-3 py-2 rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary min-h-[320px] resize-y"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <span className="text-xs text-muted-foreground">Variables:</span>
              {TEMPLATE_VARS[selected].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setContent((c) => c + v)}
                  className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={saving} onClick={() => { void handleSave() }}>
            {saving ? "Saving…" : "Save template"}
          </Button>
          {saved && <span className="text-xs text-emerald-500">Saved</span>}
        </div>
      </div>
    </div>
  )
}
