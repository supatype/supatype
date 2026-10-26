import React, { useState } from "react"
import { useStudioClient } from "../../StudioCore.js"
import { Badge, Button, Card, Input, Textarea } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { useEmailTemplate, type EmailTemplateState } from "../../hooks/useEmailTemplate.js"

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

function TemplateNav({ selected, onSelect }: { selected: TemplateId; onSelect: (id: TemplateId) => void }): React.ReactElement {
  return (
    <div className="w-44 shrink-0">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">Templates</h2>
      <nav className="flex flex-col gap-0.5">
        {TEMPLATE_TYPES.map((t) => (
          <Button
            key={t.id}
            variant="ghost"
            size="md"
            className={selected === t.id ? "bg-accent text-foreground" : ""}
            onClick={() => onSelect(t.id)}
          >
            {t.label}
          </Button>
        ))}
      </nav>
    </div>
  )
}

function Preview({ state }: { state: EmailTemplateState }): React.ReactElement {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground mb-2">Subject: <strong className="text-foreground">{state.template.subject}</strong></p>
      <iframe
        title="email preview"
        srcDoc={state.template.content}
        className="w-full min-h-[400px] border border-border rounded-md bg-white"
        sandbox="allow-same-origin"
      />
    </Card>
  )
}

function Editor({ state, variables }: { state: EmailTemplateState; variables: string[] }): React.ReactElement {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Subject line</label>
        <Input type="text" value={state.template.subject} onChange={(e) => state.setSubject(e.target.value)} />
      </div>
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Body (HTML)</label>
        <Textarea
          value={state.template.content}
          onChange={(e) => {
            const next = e.target.value
            state.setContent(() => next)
          }}
          className="min-h-[320px] resize-y"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Variables:</span>
        {variables.map((v) => (
          <Button key={v} variant="ghost" size="xs" className="font-mono" onClick={() => state.setContent((c) => c + v)}>
            {v}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** Save, and, while a saved edit is in force, say so and offer to go back to the default. */
function Actions({ state }: { state: EmailTemplateState }): React.ReactElement {
  const { savedAt } = state.template
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" disabled={state.busy} onClick={() => void state.save()}>
        {state.busy ? "Saving…" : "Save template"}
      </Button>
      {savedAt !== null && (
        <>
          <Badge variant="green">Saved edit in force since {new Date(savedAt).toLocaleString()}</Badge>
          <Button disabled={state.busy} onClick={() => void state.reset()}>
            Reset to default
          </Button>
        </>
      )}
    </div>
  )
}

export function EmailTemplatesView(): React.ReactElement {
  const client = useStudioClient()
  const [selected, setSelected] = useState<TemplateId>("confirmation")
  const [preview, setPreview] = useState(false)
  const state = useEmailTemplate(client, selected)

  return (
    <div className="flex gap-4 h-full min-h-[600px]">
      <TemplateNav selected={selected} onSelect={setSelected} />

      <div className="flex-1 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-foreground">
            {TEMPLATE_TYPES.find((t) => t.id === selected)?.label}
          </h1>
          <div className="flex items-center gap-2">
            <Button variant={preview ? "ghost" : "secondary"} onClick={() => setPreview(false)}>Edit</Button>
            <Button variant={preview ? "secondary" : "ghost"} onClick={() => setPreview(true)}>Preview</Button>
          </div>
        </div>

        {state.error && <ErrorBanner message={state.error} />}

        {state.loading ? (
          <div className="space-y-2">
            <div className="h-8 rounded-md bg-muted animate-pulse" />
            <div className="h-48 rounded-md bg-muted animate-pulse" />
          </div>
        ) : preview ? (
          <Preview state={state} />
        ) : (
          <Editor state={state} variables={TEMPLATE_VARS[selected]} />
        )}

        <Actions state={state} />
      </div>
    </div>
  )
}
