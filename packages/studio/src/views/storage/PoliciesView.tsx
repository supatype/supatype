import React, { useCallback, useState } from "react"
import { useParams } from "react-router-dom"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { usePolicyWrites } from "../../hooks/usePolicyWrites.js"
import { useSqlEditorOffered } from "../../hooks/useSqlEditorOffered.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { PolicyCreatePanel, type PolicyTarget } from "../../components/database/PolicyCreatePanel.js"
import { ManualPolicyWarning, PolicyTableCard, rlsIsOn, type PolicyTableActions } from "../../components/database/PolicyTable.js"
import { Button } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { cellText } from "../metadata-row.js"

type Row = Record<string, unknown>

/** The storage tables whose policies this view shows. */
const STORAGE_TABLES = new Set(["objects", "buckets"])

/** The rows that belong to one of the storage tables. */
function storageRows(rows: Row[]): Row[] {
  return rows.filter((r) => STORAGE_TABLES.has(cellText(r, "tablename")))
}

/** Where a new storage policy may go. */
const STORAGE_TARGET: PolicyTarget = { schema: "storage", tables: [...STORAGE_TABLES] }

/** The policies that mention the bucket, by the table they guard; every policy when no bucket is chosen. */
function groupForBucket(policies: Row[], bucket: string | null): Map<string, Row[]> {
  const needle = bucket ? `'${bucket.replace(/'/g, "''")}'` : null
  const grouped = new Map<string, Row[]>()
  for (const p of policies) {
    if (needle && !cellText(p, "qual").includes(needle) && !cellText(p, "with_check").includes(needle)) continue
    const table = cellText(p, "tablename")
    grouped.set(table, [...(grouped.get(table) ?? []), p])
  }
  return grouped
}

/** Storage's policies and row security, read through the metadata catalogue (RQ3b). */
function useStorageCatalogue() {
  const proxy = useProjectProxy()
  const policies = useApiQuery(() => proxy.metadata("policies", { schema: "storage" }).then((r) => storageRows(r.rows)), [proxy])
  const rls = useApiQuery(() => proxy.metadata("rls_status", { schema: "storage" }).then((r) => storageRows(r.rows)), [proxy])
  const { refetch } = policies
  const refetchRls = rls.refetch
  const refresh = useCallback(() => { refetch(); refetchRls() }, [refetch, refetchRls])
  const rlsMap = new Map((rls.data ?? []).map((r) => [cellText(r, "tablename"), rlsIsOn(r)]))
  return { policies: policies.data ?? [], rlsMap, loading: policies.loading, error: policies.error, refresh }
}

function StoragePolicyTables({ grouped, rlsMap, actionsFor }: { grouped: Map<string, Row[]>; rlsMap: Map<string, boolean>; actionsFor: ((table: string) => PolicyTableActions) | null }): React.ReactElement {
  return (
    <div className="space-y-4">
      {[...grouped.entries()].map(([name, policies]) => (
        <PolicyTableCard
          key={name}
          table={{ name, label: `storage.${name}`, rlsEnabled: rlsMap.get(name) ?? false, policies }}
          actions={actionsFor ? actionsFor(name) : null}
        />
      ))}
    </div>
  )
}

export function StoragePoliciesView(): React.ReactElement {
  // Writes go through `/studio-admin`, open to the SQL editor's roles only (RQ4, SQ2).
  const sqlWrites = useSqlEditorOffered()
  const params = useParams<{ bucket?: string }>()
  const [warningOpen, setWarningOpen] = useState(false)
  const [createTarget, setCreateTarget] = useState<PolicyTarget | null>(null)
  const catalogue = useStorageCatalogue()
  const writes = usePolicyWrites(catalogue.refresh)
  const bucket = params.bucket ? decodeURIComponent(params.bucket) : null
  const grouped = groupForBucket(catalogue.policies, bucket)
  const actionsFor = (table: string): PolicyTableActions => ({
    toggleRls: (enable) => { void writes.toggleRls("storage", table, enable) },
    drop: (name) => { void writes.dropPolicy("storage", table, name) },
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
      {catalogue.loading ? (
        <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}</div>
      ) : grouped.size === 0 ? (
        <EmptyState title="No storage policies" description={empty} />
      ) : (
        <StoragePolicyTables grouped={grouped} rlsMap={catalogue.rlsMap} actionsFor={sqlWrites ? actionsFor : null} />
      )}
      <PolicyCreatePanel target={createTarget} onClose={(created) => { setCreateTarget(null); if (created) catalogue.refresh() }} />
      {warningOpen ? <ManualPolicyWarning subject="storage access policies" onCancel={() => { setWarningOpen(false) }} onContinue={() => { setWarningOpen(false); setCreateTarget(STORAGE_TARGET) }} /> : null}
    </div>
  )
}
