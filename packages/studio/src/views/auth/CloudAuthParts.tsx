import React, { useCallback, useState } from "react"
import type { AuthSettingValue } from "@supatype/types"
import { Badge, Button, Input, Select, Switch, Td, Textarea } from "../../components/ui.js"
import {
  useCloudAuthSettings,
  type AuthFieldView,
  type AuthSettingsEdit,
  type AuthSettingsView,
} from "../../hooks/useCloudAuthSettings.js"
import { usePlatform } from "../../hooks/usePlatform.js"
import { useStudioCapability } from "../../hooks/useStudioCapability.js"
import { offers } from "../../lib/capability-offers.js"

/**
 * The pieces the Cloud Configuration and Providers pages share: one editor over the environment's
 * auth settings, a row per setting with its value, source and reset, and a write-only secret row.
 */

/** Who may write auth settings: owner, admin and developer, the roles `administer` names. */
const WRITE_PERMISSION = "administer"

export interface CloudAuthEditor {
  view: AuthSettingsView | null
  loading: boolean
  error: string | null
  /** Whether the caller's role may write; the server still decides. */
  canEdit: boolean
  busy: boolean
  save: (edit: AuthSettingsEdit) => Promise<boolean>
}

/** Cloud with a known environment, or null: the page then stays the read-only self-host one. */
export function useCloudEnvironment(): string | null {
  const { platformUrl, environment } = usePlatform()
  return platformUrl !== undefined && environment !== undefined ? environment : null
}

export function useCloudAuthEditor(environment: string): CloudAuthEditor {
  const settings = useCloudAuthSettings(environment)
  const capability = useStudioCapability()
  const [busy, setBusy] = useState(false)
  const { save: send } = settings
  const save = useCallback(
    async (edit: AuthSettingsEdit): Promise<boolean> => {
      setBusy(true)
      try {
        return await send(edit)
      } finally {
        setBusy(false)
      }
    },
    [send],
  )
  const canEdit = capability.settled && offers(capability, WRITE_PERMISSION)
  return { view: settings.view, loading: settings.loading, error: settings.error, canEdit, busy, save }
}

const NO_FIELD: AuthFieldView = { value: null, source: "default", codeValue: null, differsFromCode: false, updatedAt: null, updatedBy: null }

/** A path's field; one the server left out reads as unset. */
export function fieldOf(view: AuthSettingsView, path: string): AuthFieldView {
  return view.fields[path] ?? NO_FIELD
}

/** "2026-11-13T10:00:00Z" as "2026-11-13 10:00", the same wherever the viewer is. */
function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ")
}

function stamp(field: AuthFieldView): string {
  const at = field.updatedAt !== null ? `, ${when(field.updatedAt)}` : ""
  const by = field.updatedBy !== null ? ` by ${field.updatedBy}` : ""
  return `${at}${by}`
}

/** Where a value comes from, in the words the design note gives each layer. */
export function sourceText(field: AuthFieldView): string {
  if (field.source === "code") return `supatype.config.ts, pushed${stamp(field)}`
  if (field.source === "studio") return `Studio edit${stamp(field)}`
  return "default"
}

/** Whether the running auth server has this version, or the write is still waiting. */
export function AppliedBadge({ view }: { view: AuthSettingsView }): React.ReactElement {
  const applied = view.appliedVersion === view.version
  return <Badge variant={applied ? "green" : "yellow"}>{applied ? "applied" : "written, not yet applied"}</Badge>
}

export type SettingKind = "text" | "number" | "bool" | "list" | "select"

export interface SettingSpec {
  path: string
  label: string
  kind: SettingKind
  options?: readonly string[]
  /** List entries that are always present and cannot be removed. */
  fixed?: readonly string[]
}

function draftText(value: AuthSettingValue | null): string {
  if (Array.isArray(value)) return value.join("\n")
  return value === null ? "" : String(value)
}

/** What a draft saves as, or null when it is not a valid value of the kind. */
function draftValue(kind: SettingKind, draft: string): AuthSettingValue | null {
  if (kind === "list") return draft.split("\n").map((line) => line.trim()).filter((line) => line !== "")
  if (kind !== "number") return draft
  const n = Number(draft)
  return draft.trim() === "" || Number.isNaN(n) ? null : n
}

function shown(value: AuthSettingValue | null): React.ReactNode {
  if (typeof value === "boolean") return <Badge variant={value ? "green" : "outline"}>{value ? "On" : "Off"}</Badge>
  if (value === null) return <span className="text-muted-foreground">Not set</span>
  return <span className="break-all">{Array.isArray(value) ? value.join(", ") : String(value)}</span>
}

interface RowProps {
  spec: SettingSpec
  field: AuthFieldView
  editor: CloudAuthEditor
}

function TextEditor({ spec, field, editor }: RowProps): React.ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? draftText(field.value)
  const next = draft === null ? null : draftValue(spec.kind, draft)
  const common = { "aria-label": spec.label, value: text, disabled: editor.busy }
  const save = async (): Promise<void> => {
    if (next !== null && (await editor.save({ set: { [spec.path]: next } }))) setDraft(null)
  }
  return (
    <div className="flex items-start gap-2">
      {spec.kind === "list" ? (
        <Textarea {...common} rows={3} onChange={(e) => { setDraft(e.target.value) }} />
      ) : (
        <Input {...common} onChange={(e) => { setDraft(e.target.value) }} />
      )}
      {next !== null && draft !== draftText(field.value) ? (
        <Button size="xs" variant="primary" disabled={editor.busy} onClick={() => { void save() }}>{`Save ${spec.label}`}</Button>
      ) : null}
    </div>
  )
}

function ChoiceEditor({ spec, field, editor }: RowProps): React.ReactElement {
  return (
    <Select aria-label={spec.label} value={draftText(field.value)} disabled={editor.busy} onChange={(e) => { void editor.save({ set: { [spec.path]: e.target.value } }) }}>
      <option value="" disabled>Not set</option>
      {(spec.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
    </Select>
  )
}

function ValueCell({ spec, field, editor }: RowProps): React.ReactElement {
  if (!editor.canEdit) return <>{shown(field.value)}</>
  if (spec.kind === "bool") {
    return <Switch label={spec.label} checked={field.value === true} disabled={editor.busy} onChange={(on) => { void editor.save({ set: { [spec.path]: on } }) }} />
  }
  if (spec.kind === "select") return <ChoiceEditor spec={spec} field={field} editor={editor} />
  return <TextEditor key={draftText(field.value)} spec={spec} field={field} editor={editor} />
}

function SourceCell({ spec, field, editor }: RowProps): React.ReactElement {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground">{sourceText(field)}</div>
      {field.differsFromCode ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="yellow">Differs from config</Badge>
          <span className="text-xs text-muted-foreground">Config says {draftText(field.codeValue) || "nothing"}</span>
          {editor.canEdit ? (
            <Button size="xs" variant="secondary" disabled={editor.busy} aria-label={`Reset ${spec.label}`} onClick={() => { void editor.save({ reset: [spec.path] }) }}>Reset</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** One setting: its label, an editor (or the value, for a role that cannot write), and its source. */
export function SettingRow({ spec, field, editor }: RowProps): React.ReactElement {
  return (
    <tr className="border-b border-border last:border-0 align-top">
      <Td className="px-4 py-3 whitespace-nowrap">{spec.label}</Td>
      <Td className="px-4 py-3">
        <ValueCell spec={spec} field={field} editor={editor} />
        {spec.fixed?.map((entry) => (
          <div key={entry} className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">platform</Badge><code className="font-mono break-all">{entry}</code>
          </div>
        ))}
      </Td>
      <Td className="px-4 py-3 text-xs"><SourceCell spec={spec} field={field} editor={editor} /></Td>
    </tr>
  )
}

/** "set (...a1f9)" or "not set": never the value. */
function secretStatus(view: AuthSettingsView, key: string): string {
  const secret = view.secrets[key]
  if (secret === undefined || !secret.set) return "not set"
  return secret.fingerprint !== null ? `set (...${secret.fingerprint})` : "set"
}

function SecretControls({ secretKey, label, isSet, editor }: { secretKey: string; label: string; isSet: boolean; editor: CloudAuthEditor }): React.ReactElement {
  const [draft, setDraft] = useState("")
  const replace = async (): Promise<void> => {
    const sent = draft
    setDraft("")
    await editor.save({ secrets: { [secretKey]: sent } })
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input type="password" autoComplete="new-password" aria-label={`${label} secret`} value={draft} disabled={editor.busy} onChange={(e) => { setDraft(e.target.value) }} />
      <Button size="xs" variant="primary" disabled={editor.busy || draft === ""} aria-label={`${isSet ? "Replace" : "Set"} ${label} secret`} onClick={() => { void replace() }}>{isSet ? "Replace" : "Set"}</Button>
      {isSet ? (
        <Button size="xs" variant="destructive" disabled={editor.busy} aria-label={`Remove ${label} secret`} onClick={() => { void editor.save({ secrets: { [secretKey]: null } }) }}>Remove</Button>
      ) : null}
    </div>
  )
}

/**
 * One write-only secret: its status, and for a role that may write, a password input that is never
 * pre-filled and is cleared the moment it is sent.
 */
export function SecretRow({ secretKey, label, editor }: { secretKey: string; label: string; editor: CloudAuthEditor }): React.ReactElement | null {
  if (editor.view === null) return null
  const isSet = editor.view.secrets[secretKey]?.set === true
  return (
    <tr className="border-b border-border last:border-0 align-top">
      <Td className="px-4 py-3 whitespace-nowrap">{label} secret</Td>
      <Td className="px-4 py-3">{secretStatus(editor.view, secretKey)}</Td>
      <Td className="px-4 py-3">
        {editor.canEdit ? <SecretControls secretKey={secretKey} label={label} isSet={isSet} editor={editor} /> : null}
      </Td>
    </tr>
  )
}
