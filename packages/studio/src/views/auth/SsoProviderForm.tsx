import React, { useRef, useState } from "react"
import { Button, DropZone, FileInput, Input, Modal, Select, Tabs, Textarea } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import {
  NAME_ID_FORMATS,
  parseAttributeMapping,
  parseDomains,
  providerName,
  type MetadataSource,
  type SsoProvider,
  type SsoProviderDraft,
  type WriteOutcome,
} from "../../lib/sso-providers.js"

/**
 * Adding a SAML identity provider, or changing one in place. A provider being changed keeps its
 * name: the name is the `resource_id` the CLI and the admin API address it by.
 */

type SourceTab = "url" | "xml"

interface FormFields {
  name: string
  source: SourceTab
  url: string
  xml: string
  domains: string
  nameIdFormat: string
  mapping: string
}

/** What the form edits and where its answer goes. */
export interface ProviderFormTask {
  /** The provider being changed, or null to add one. */
  editing: SsoProvider | null
  save: (draft: SsoProviderDraft) => Promise<WriteOutcome>
  close: () => void
}

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/
const LABEL = "block text-xs text-muted-foreground mb-1"

function startingFields(editing: SsoProvider | null): FormFields {
  return {
    name: editing ? providerName(editing) : "",
    source: editing && editing.metadataUrl === null ? "xml" : "url",
    url: editing?.metadataUrl ?? "",
    xml: "",
    domains: editing?.domains.map((d) => d.domain).join(", ") ?? "",
    nameIdFormat: editing?.nameIdFormat ?? "",
    mapping: editing?.attributeMapping ? JSON.stringify(editing.attributeMapping, null, 2) : "",
  }
}

/** The metadata to send: what was given, or `keep` for an edit that left it as it was. */
function metadataOf(fields: FormFields, editing: SsoProvider | null): MetadataSource | string {
  const url = fields.url.trim()
  const xml = fields.xml.trim()
  if (fields.source === "url" && url !== "" && url !== (editing?.metadataUrl ?? "")) return { kind: "url", url }
  if (fields.source === "xml" && xml !== "") return { kind: "xml", xml: fields.xml }
  if (editing !== null) return { kind: "keep" }
  return fields.source === "url" ? "Give the identity provider's metadata URL" : "Upload or paste the identity provider's metadata XML"
}

/** The draft the fields describe, or the first thing wrong with them. */
export function draftOf(fields: FormFields, editing: SsoProvider | null): SsoProviderDraft | string {
  const name = fields.name.trim()
  if (editing === null && !NAME_PATTERN.test(name)) return "Give the provider a name of letters, digits, dots, dashes or underscores"
  const metadata = metadataOf(fields, editing)
  if (typeof metadata === "string") return metadata
  const mapping = parseAttributeMapping(fields.mapping)
  if (!mapping.ok) return mapping.error
  return { name, metadata, domains: parseDomains(fields.domains), nameIdFormat: fields.nameIdFormat, attributeMapping: mapping.mapping }
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <label htmlFor={id} className={LABEL}>{label}</label>
      {children}
    </div>
  )
}

type SetField = <K extends keyof FormFields>(key: K, value: FormFields[K]) => void

/** The metadata XML: a file chosen or dropped, or pasted into the box. */
function XmlSource({ fields, set, onError }: { fields: FormFields; set: SetField; onError: (message: string) => void }): React.ReactElement {
  const fileRef = useRef<HTMLInputElement>(null)
  const read = (files: FileList): void => {
    const file = files[0]
    if (file === undefined) return
    file.text().then((xml) => { set("xml", xml) }, () => { onError(`Could not read ${file.name}`) })
  }
  return (
    <div className="space-y-2">
      <DropZone className="p-4">
        <Button type="button" size="xs" onClick={() => { fileRef.current?.click() }}>Choose file</Button>
        <span>or paste the XML below</span>
        <FileInput ref={fileRef} accept=".xml,application/xml,text/xml" aria-label="Metadata XML file" onFiles={read} />
      </DropZone>
      <Textarea id="sso-metadata-xml" aria-label="Metadata XML" value={fields.xml} onChange={(e) => { set("xml", e.target.value) }} className="min-h-[120px]" />
    </div>
  )
}

const SOURCE_TABS = { label: "Metadata source", look: "pill", size: "xs", items: [{ id: "url", label: "Metadata URL" }, { id: "xml", label: "Metadata XML" }] } as const

function MetadataFields({ fields, set, onError }: { fields: FormFields; set: SetField; onError: (message: string) => void }): React.ReactElement {
  return (
    <div className="space-y-2">
      <Tabs tabs={SOURCE_TABS} value={fields.source} onChange={(tab) => { set("source", tab) }} />
      {fields.source === "url" ? (
        <Input id="sso-metadata-url" aria-label="Metadata URL" type="url" placeholder="https://idp.example.com/metadata" value={fields.url} onChange={(e) => { set("url", e.target.value) }} />
      ) : (
        <XmlSource fields={fields} set={set} onError={onError} />
      )}
    </div>
  )
}

function SettingsFields({ fields, set, editing }: { fields: FormFields; set: SetField; editing: boolean }): React.ReactElement {
  return (
    <>
      <Field id="sso-name" label="Name">
        <Input id="sso-name" value={fields.name} disabled={editing} placeholder="acme" onChange={(e) => { set("name", e.target.value) }} />
      </Field>
      <Field id="sso-domains" label="Email domains that sign in through it">
        <Input id="sso-domains" value={fields.domains} placeholder="acme.com, acme.co.uk" onChange={(e) => { set("domains", e.target.value) }} />
      </Field>
      <Field id="sso-name-id-format" label="NameID format">
        <Select id="sso-name-id-format" value={fields.nameIdFormat} onChange={(e) => { set("nameIdFormat", e.target.value) }}>
          {NAME_ID_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </Select>
      </Field>
      <Field id="sso-attribute-mapping" label="Attribute mapping (optional JSON)">
        <Textarea id="sso-attribute-mapping" value={fields.mapping} placeholder='{"keys": {"email": {"name": "mail"}}}' onChange={(e) => { set("mapping", e.target.value) }} className="min-h-[80px]" />
      </Field>
    </>
  )
}

/** Check the fields, send them, and close once the server has taken them. */
function useSubmit(task: ProviderFormTask, fields: FormFields): { error: string | null; setError: (e: string | null) => void; busy: boolean; submit: () => void } {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = (): void => {
    const draft = draftOf(fields, task.editing)
    if (typeof draft === "string") { setError(draft); return }
    setBusy(true)
    task.save(draft).then(
      (outcome) => { setBusy(false); if (outcome === null) task.close(); else setError(outcome) },
      (err: unknown) => { setBusy(false); setError(err instanceof Error ? err.message : String(err)) },
    )
  }
  return { error, setError, busy, submit }
}

export function SsoProviderForm({ task }: { task: ProviderFormTask }): React.ReactElement {
  const [fields, setFields] = useState(() => startingFields(task.editing))
  const set: SetField = (key, value) => { setFields((f) => ({ ...f, [key]: value })) }
  const { error, setError, busy, submit } = useSubmit(task, fields)
  const title = task.editing ? `Edit ${providerName(task.editing)}` : "Add SAML provider"
  return (
    <Modal label={title} onClose={task.close}>
      <form className="space-y-4 overflow-y-auto p-6" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {error !== null && <ErrorBanner message={error} />}
        <MetadataFields fields={fields} set={set} onError={setError} />
        {task.editing && <p className="text-xs text-muted-foreground">Leave the metadata as it is to keep what the server holds. New metadata must name the same entity ID.</p>}
        <SettingsFields fields={fields} set={set} editing={task.editing !== null} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={task.close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>{task.editing ? "Save changes" : "Add provider"}</Button>
        </div>
      </form>
    </Modal>
  )
}
