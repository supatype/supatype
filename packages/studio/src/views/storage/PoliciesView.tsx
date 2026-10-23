import React, { useState } from "react"
import { useParams } from "react-router-dom"
import { usePolicyWrites } from "../../hooks/usePolicyWrites.js"
import { useSqlEditorOffered } from "../../hooks/useSqlEditorOffered.js"
import { groupByTable, usePolicyCatalogue, type PolicyCatalogue } from "../../hooks/usePolicyCatalogue.js"
import { PolicyCreatePanel, type PolicyTarget } from "../../components/database/PolicyCreatePanel.js"
import { ManualPolicyWarning, PolicyTableList, type PolicyTableActions } from "../../components/database/PolicyTable.js"
import { Button } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { cellText } from "../metadata-row.js"
import type { RoleRequirement } from "../../components/RoleGate.js"

type Row = Record<string, unknown>

/** The storage tables whose policies this view shows. */
const STORAGE_TABLES = new Set(["objects", "buckets"])

/** Whether a catalogue row belongs to one of the storage tables. */
function isStorageRow(row: Row): boolean {
  return STORAGE_TABLES.has(cellText(row, "tablename"))
}

/** Where a new storage policy may go. */
const STORAGE_TARGET: PolicyTarget = { schema: "storage", tables: [...STORAGE_TABLES] }

/** The catalogue narrowed to the policies that mention the bucket; all of it when none is chosen. */
function forBucket(catalogue: PolicyCatalogue, bucket: string | null): PolicyCatalogue {
  if (bucket === null) return catalogue
  const needle = `'${bucket.replace(/'/g, "''")}'`
  const mentions = (p: Row): boolean => cellText(p, "qual").includes(needle) || cellText(p, "with_check").includes(needle)
  return { ...catalogue, grouped: groupByTable([...catalogue.grouped.values()].flat().filter(mentions)) }
}

/**
 * Who may open a bucket's Policies tab: whoever reads the schema, and an editor, who works with the
 * bucket's files and reads the rules that govern them (owner decision on fresh-test C8). Changing
 * them is still the SQL editor's roles' alone; see `sqlWrites`.
 */
export const STORAGE_POLICIES: RoleRequirement = { needs: ["schemaView", "write"], activity: "view access policies" }

export function StoragePoliciesView(): React.ReactElement {
  // Writes go through `/studio-admin`, open to the SQL editor's roles only (RQ4, SQ2).
  const sqlWrites = useSqlEditorOffered()
  const params = useParams<{ bucket?: string }>()
  const [warningOpen, setWarningOpen] = useState(false)
  const [createTarget, setCreateTarget] = useState<PolicyTarget | null>(null)
  const all = usePolicyCatalogue("storage", isStorageRow)
  const writes = usePolicyWrites(all.refresh)
  const bucket = params.bucket ? decodeURIComponent(params.bucket) : null
  const catalogue = forBucket(all, bucket)
  const actionsFor = (table: string): PolicyTableActions => ({
    toggleRls: (enable) => { void writes.toggleRls("storage", table, enable) },
    drop: (name) => { void writes.dropPolicy("storage", table, name) },
    dropsAt: { schema: "storage", table },
  })
  const empty = bucket ? `No RLS policies matched bucket '${bucket}'.` : "No RLS policies found on storage tables."
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Storage Policies</h1>
        {sqlWrites ? <Button variant="primary" onClick={() => { setWarningOpen(true) }}>Create policy</Button> : null}
      </div>
      {catalogue.error && <ErrorBanner message={catalogue.error} />}
      {writes.writeError && <ErrorBanner message={writes.writeError} />}
      <PolicyTableList
        catalogue={catalogue}
        options={{ label: (table) => `storage.${table}`, actionsFor: sqlWrites ? actionsFor : null, empty: { title: "No storage policies", description: empty } }}
      />
      <PolicyCreatePanel target={createTarget} onClose={(created) => { setCreateTarget(null); if (created) all.refresh() }} />
      {warningOpen ? <ManualPolicyWarning subject="storage access policies" onCancel={() => { setWarningOpen(false) }} onContinue={() => { setWarningOpen(false); setCreateTarget(STORAGE_TARGET) }} /> : null}
    </div>
  )
}
