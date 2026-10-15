import React, { useState } from "react"
import {
  useProjectProxy,
  type PolicyCommand,
  type StudioAdminSchema,
  type StudioPolicyWrite,
} from "../../hooks/useProjectProxy.js"
import { Button, Input, Select, Textarea } from "../ui.js"
import { ErrorBanner } from "../ErrorBanner.js"
import { SlidePanel } from "../SlidePanel.js"

/** Where a new policy may go: an admin schema and the tables in it the view knows of. */
export interface PolicyTarget {
  schema: StudioAdminSchema
  tables: string[]
}

/** The form's fields as typed; roles are a comma separated list. */
export interface PolicyDraft {
  table: string
  name: string
  command: PolicyCommand
  roles: string
  using: string
  check: string
}

const COMMANDS: PolicyCommand[] = ["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"]

/** Postgres takes no USING on an INSERT policy. */
function takesUsing(command: PolicyCommand): boolean {
  return command !== "INSERT"
}

/** Postgres takes WITH CHECK only where rows are written. */
function takesCheck(command: PolicyCommand): boolean {
  return command === "ALL" || command === "INSERT" || command === "UPDATE"
}

/** An expression field as sent: trimmed, or null when blank or not taken by the command. */
function expression(text: string, taken: boolean): string | null {
  const trimmed = text.trim()
  return taken && trimmed !== "" ? trimmed : null
}

/** The `/studio-admin/policies` create body for a filled-in form. */
export function policyCreateBody(schema: StudioAdminSchema, draft: PolicyDraft): StudioPolicyWrite {
  const roles = draft.roles.split(",").map((r) => r.trim()).filter((r) => r !== "")
  return {
    schema,
    table: draft.table,
    op: "create",
    name: draft.name.trim(),
    command: draft.command,
    ...(roles.length > 0 && { roles }),
    using: expression(draft.using, takesUsing(draft.command)),
    check: expression(draft.check, takesCheck(draft.command)),
  }
}

interface FieldsProps {
  draft: PolicyDraft
  tables: string[]
  onChange: (patch: Partial<PolicyDraft>) => void
}

function FieldLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return <label className="block text-[0.8rem] text-muted-foreground mb-1">{children}</label>
}

function PolicyShapeFields({ draft, tables, onChange }: FieldsProps): React.ReactElement {
  return (
    <>
      <div>
        <FieldLabel>Table</FieldLabel>
        <Select aria-label="Table" className="w-full" value={draft.table} onChange={(e) => onChange({ table: e.target.value })}>
          {tables.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
      </div>
      <div>
        <FieldLabel>Policy name</FieldLabel>
        <Input aria-label="Policy name" value={draft.name} onChange={(e) => onChange({ name: e.target.value })} />
      </div>
      <div>
        <FieldLabel>Command</FieldLabel>
        <Select aria-label="Command" className="w-full" value={draft.command} onChange={(e) => onChange({ command: e.target.value as PolicyCommand })}>
          {COMMANDS.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </div>
      <div>
        <FieldLabel>Roles (comma separated, blank for public)</FieldLabel>
        <Input aria-label="Roles" placeholder="authenticated" value={draft.roles} onChange={(e) => onChange({ roles: e.target.value })} />
      </div>
    </>
  )
}

function PolicyExpressionFields({ draft, onChange }: Omit<FieldsProps, "tables">): React.ReactElement {
  return (
    <>
      <div>
        <FieldLabel>USING</FieldLabel>
        <Textarea aria-label="USING" rows={3} disabled={!takesUsing(draft.command)} value={draft.using} onChange={(e) => onChange({ using: e.target.value })} />
      </div>
      <div>
        <FieldLabel>WITH CHECK</FieldLabel>
        <Textarea aria-label="WITH CHECK" rows={3} disabled={!takesCheck(draft.command)} value={draft.check} onChange={(e) => onChange({ check: e.target.value })} />
      </div>
    </>
  )
}

interface PanelProps {
  /** The schema and tables to create in, or null while the panel is closed. */
  target: PolicyTarget | null
  /** Called when the panel closes, with whether a policy was created. */
  onClose: (created: boolean) => void
}

function PolicyForm({ target, onClose }: PanelProps & { target: PolicyTarget }): React.ReactElement {
  const proxy = useProjectProxy()
  const [draft, setDraft] = useState<PolicyDraft>({ table: target.tables[0] ?? "", name: "", command: "ALL", roles: "", using: "", check: "" })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const onChange = (patch: Partial<PolicyDraft>): void => setDraft((d) => ({ ...d, ...patch }))

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await proxy.studioPolicy(policyCreateBody(target.schema, draft))
      onClose(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PolicyShapeFields draft={draft} tables={target.tables} onChange={onChange} />
      <PolicyExpressionFields draft={draft} onChange={onChange} />
      {error && <ErrorBanner message={error} />}
      <div className="flex justify-end gap-2">
        <Button onClick={() => onClose(false)}>Cancel</Button>
        <Button variant="primary" disabled={busy || draft.table === "" || draft.name.trim() === ""} onClick={() => { void save() }}>
          {busy ? "Saving…" : "Save policy"}
        </Button>
      </div>
    </div>
  )
}

/**
 * Creates one policy on an auth or storage table through `/studio-admin/policies` (SQ2): the SQL
 * editor's login cannot, so the policy is described field by field rather than as SQL text.
 */
export function PolicyCreatePanel({ target, onClose }: PanelProps): React.ReactElement {
  return (
    <SlidePanel
      open={target !== null}
      onClose={() => onClose(false)}
      title="Create policy"
      subtitle={target ? `${target.schema} schema` : undefined}
    >
      {target && <PolicyForm target={target} onClose={onClose} />}
    </SlidePanel>
  )
}
