import React, { useCallback, useMemo, useState } from "react"
import { isStudioAdminSchema, useProjectProxy } from "../../hooks/useProjectProxy.js"
import { usePolicyWrites } from "../../hooks/usePolicyWrites.js"
import { PolicyCreatePanel, type PolicyTarget } from "../../components/database/PolicyCreatePanel.js"
import { ManualPolicyWarning, PolicyTableCard, rlsIsOn, type PolicyTableActions } from "../../components/database/PolicyTable.js"
import { useSqlEditorOffered } from "../../hooks/useSqlEditorOffered.js"
import { useSchemaPicker } from "../../hooks/useSchemaPicker.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Button, Dialog, Select, Textarea } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { isJsonObject } from "../../lib/json.js"
import { cellText } from "../metadata-row.js"

type Row = Record<string, unknown>

/** Match server-side identifier rules so schema hints stay safe in SQL text. */
function safeSchemaName(schema: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) return "public"
  // pg_catalog stores unquoted schema names lowercased, fold so we match information_schema + pg_policies.
  return schema.toLowerCase()
}

function jsonRows(raw: unknown): Row[] {
  return Array.isArray(raw) ? raw.filter(isJsonObject) : []
}

/** Policies by the table they guard, in the order the catalogue listed them. */
function groupByTable(policies: Row[]): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>()
  for (const p of policies) {
    const table = cellText(p, "tablename") || "(unknown)"
    grouped.set(table, [...(grouped.get(table) ?? []), p])
  }
  return grouped
}

const POLICY_TEMPLATE = (schema: string): string =>
  `CREATE POLICY my_policy ON ${schema}.my_table\n  AS PERMISSIVE\n  FOR ALL\n  TO authenticated\n  USING (true)\n  WITH CHECK (true);`

/** The schema's policies and row security, read through the metadata catalogue (RQ3b). */
function usePolicyCatalogue(schemaSql: string) {
  const proxy = useProjectProxy()
  const policies = useApiQuery(() => proxy.metadata("policies", { schema: schemaSql }).then((r) => r.rows), [proxy, schemaSql])
  const rls = useApiQuery(() => proxy.metadata("rls_status", { schema: schemaSql }).then((r) => r.rows), [proxy, schemaSql])
  const { refetch } = policies
  const refetchRls = rls.refetch
  const refresh = useCallback(() => { refetch(); refetchRls() }, [refetch, refetchRls])
  const grouped = useMemo(() => groupByTable(jsonRows(policies.data)), [policies.data])
  const rlsMap = useMemo(() => new Map(jsonRows(rls.data).map((r) => [cellText(r, "tablename"), rlsIsOn(r)])), [rls.data])
  return { grouped, rlsMap, loading: policies.loading, error: policies.error, refresh }
}

/** The SQL a write on a schema outside `/studio-admin` runs, shown for the user to edit and run. */
function useSqlDraft(schemaSql: string, onRan: () => void) {
  const proxy = useProjectProxy()
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = (): void => { setText(null); setError(null) }
  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await proxy.sql(text ?? "", schemaSql)
      close()
      onRan()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return { text, setText, error, busy, close, run }
}

type SqlDraft = ReturnType<typeof useSqlDraft>

function SqlDraftDialog({ draft }: { draft: SqlDraft }): React.ReactElement | null {
  if (draft.text === null) return null
  return (
    <Dialog
      title="SQL"
      actions={<><Button onClick={draft.close}>Cancel</Button><Button variant="primary" disabled={draft.busy} onClick={() => { void draft.run() }}>{draft.busy ? "Running…" : "Run SQL"}</Button></>}
    >
      <Textarea aria-label="SQL" className="min-h-[140px] resize-y" value={draft.text} onChange={(e) => { draft.setText(e.target.value) }} />
      {draft.error ? <p className="text-xs text-destructive">{draft.error}</p> : null}
    </Dialog>
  )
}

type Catalogue = ReturnType<typeof usePolicyCatalogue>

/** Every table the view has seen in this schema, with or without a policy yet. */
function knownTables(catalogue: Catalogue): string[] {
  return [...new Set([...catalogue.rlsMap.keys(), ...catalogue.grouped.keys()])].filter((t) => t !== "").sort()
}

/**
 * The writes the view offers, on whichever route the schema takes. The SQL editor's login cannot
 * alter auth or storage tables, so those go through `/studio-admin` (SQ2); any other schema keeps
 * the SQL editor's route, and a drop or a new policy there is SQL the user reviews before it runs.
 */
function usePolicyEditing(schemaSql: string, catalogue: Catalogue) {
  const proxy = useProjectProxy()
  const writes = usePolicyWrites(catalogue.refresh)
  const draft = useSqlDraft(schemaSql, catalogue.refresh)
  const [createTarget, setCreateTarget] = useState<PolicyTarget | null>(null)
  const adminSchema = isStudioAdminSchema(schemaSql) ? schemaSql : null
  const actionsFor = (table: string): PolicyTableActions => ({
    toggleRls: (enable) => {
      if (adminSchema) void writes.toggleRls(adminSchema, table, enable)
      else void writes.run(() => proxy.sql(`ALTER TABLE ${schemaSql}.${table} ${enable ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY;`, schemaSql))
    },
    drop: (name) => {
      if (adminSchema) void writes.dropPolicy(adminSchema, table, name)
      else draft.setText(`DROP POLICY ${name} ON ${schemaSql}.${table};`)
    },
  })
  const create = (): void => {
    if (adminSchema) setCreateTarget({ schema: adminSchema, tables: knownTables(catalogue) })
    else draft.setText(POLICY_TEMPLATE(schemaSql))
  }
  return { writeError: writes.writeError, draft, createTarget, setCreateTarget, actionsFor, create }
}

function PolicyTables({ catalogue, schemaSql, actionsFor }: { catalogue: Catalogue; schemaSql: string; actionsFor: ((table: string) => PolicyTableActions) | null }): React.ReactElement {
  if (catalogue.loading) {
    return <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}</div>
  }
  if (catalogue.grouped.size === 0) {
    return <EmptyState title="No policies" description={`No RLS policies found in schema "${schemaSql}".`} />
  }
  return (
    <div className="space-y-4">
      {[...catalogue.grouped.entries()].map(([name, policies]) => (
        <PolicyTableCard
          key={name}
          table={{ name, label: name, rlsEnabled: catalogue.rlsMap.get(name) ?? false, policies }}
          actions={actionsFor ? actionsFor(name) : null}
        />
      ))}
    </div>
  )
}

export function PoliciesView(): React.ReactElement {
  // Writes are open to the SQL editor's roles only, on whichever route they take (RQ4, SQ2).
  const sqlWrites = useSqlEditorOffered()
  const { schemas, schema, setSchema } = useSchemaPicker()
  const schemaSql = useMemo(() => safeSchemaName(schema), [schema])
  const catalogue = usePolicyCatalogue(schemaSql)
  const editing = usePolicyEditing(schemaSql, catalogue)
  const [warningOpen, setWarningOpen] = useState(false)
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground">Policies</h1>
          <Select aria-label="Schema" value={schema} onChange={(e) => { setSchema(e.target.value) }}>
            {(schemas.length > 0 ? schemas : [schema]).map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </div>
        {sqlWrites ? <Button variant="primary" onClick={() => { setWarningOpen(true) }}>Create policy</Button> : null}
      </div>
      {catalogue.error && <ErrorBanner message={catalogue.error} />}
      {editing.writeError && <ErrorBanner message={editing.writeError} />}
      <PolicyTables catalogue={catalogue} schemaSql={schemaSql} actionsFor={sqlWrites ? editing.actionsFor : null} />
      <SqlDraftDialog draft={editing.draft} />
      <PolicyCreatePanel target={editing.createTarget} onClose={(created) => { editing.setCreateTarget(null); if (created) catalogue.refresh() }} />
      {warningOpen ? <ManualPolicyWarning subject="row-level security policies" onCancel={() => { setWarningOpen(false) }} onContinue={() => { setWarningOpen(false); editing.create() }} /> : null}
    </div>
  )
}
