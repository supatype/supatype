import React, { useCallback, useState } from "react"
import { useParams } from "react-router-dom"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { usePolicyWrites } from "../../hooks/usePolicyWrites.js"
import { useSqlEditorOffered } from "../../hooks/useSqlEditorOffered.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { PolicyCreatePanel, type PolicyTarget } from "../../components/database/PolicyCreatePanel.js"
import { DropPolicyButton } from "../../components/database/DropPolicyButton.js"
import { Badge, Button, Card } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { cellText, cellTextOrNull } from "../metadata-row.js"

/** The storage tables whose policies this view shows. */
const STORAGE_TABLES = new Set(["objects", "buckets"])

/** The rows that belong to one of the storage tables. */
function storageRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.filter((r) => STORAGE_TABLES.has(cellText(r, "tablename")))
}

/** Where a new storage policy may go. */
const STORAGE_TARGET: PolicyTarget = { schema: "storage", tables: [...STORAGE_TABLES] }

export function StoragePoliciesView(): React.ReactElement {
  const proxy = useProjectProxy()
  // Writes go through `/studio-admin`, open to the SQL editor's roles only (RQ4, SQ2).
  const sqlWrites = useSqlEditorOffered()
  const params = useParams<{ bucket?: string }>()
  const [manualPolicyWarningOpen, setManualPolicyWarningOpen] = useState(false)
  const [createTarget, setCreateTarget] = useState<PolicyTarget | null>(null)

  // Reads go through the metadata catalogue (RQ3b), so a viewer sees the policies too.
  const { data: policies, loading, error, refetch } = useApiQuery(
    () => proxy.metadata("policies", { schema: "storage" }).then((r) => storageRows(r.rows)),
    [proxy],
  )
  const { data: rlsStatus, refetch: refetchRls } = useApiQuery(
    () => proxy.metadata("rls_status", { schema: "storage" }).then((r) => storageRows(r.rows)),
    [proxy],
  )

  const rlsMap = new Map((rlsStatus ?? []).map((r) => [cellText(r, "tablename"), r["rls_enabled"] === true]))

  const grouped = new Map<string, typeof policies>()
  const selectedBucket = params.bucket ? decodeURIComponent(params.bucket) : null
  const bucketNeedle = selectedBucket ? `'${selectedBucket.replace(/'/g, "''")}'` : null
  const filteredPolicies = (policies ?? []).filter((p) => {
    if (!bucketNeedle) return true
    const qual = cellText(p, "qual")
    const withCheck = cellText(p, "with_check")
    return qual.includes(bucketNeedle) || withCheck.includes(bucketNeedle)
  })
  for (const p of filteredPolicies) {
    const t = cellText(p, "tablename")
    if (!grouped.has(t)) grouped.set(t, [])
    grouped.get(t)!.push(p)
  }

  const refresh = useCallback(() => { refetch(); refetchRls() }, [refetch, refetchRls])
  const writes = usePolicyWrites(refresh)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Storage Policies</h1>
        {sqlWrites ? (
          <Button variant="primary" onClick={() => {
            setManualPolicyWarningOpen(true)
          }}>
            Create policy
          </Button>
        ) : null}
      </div>

      {error && <ErrorBanner message={error} />}
      {writes.writeError && <ErrorBanner message={writes.writeError} />}

      {loading ? (
        <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}</div>
      ) : filteredPolicies.length === 0 ? (
        <EmptyState
          title="No storage policies"
          description={
            selectedBucket
              ? `No RLS policies matched bucket '${selectedBucket}'.`
              : "No RLS policies found on storage tables."
          }
        />
      ) : (
        <div className="space-y-4">
          {Array.from(grouped.entries()).map(([tableName, tablePolicies]) => {
            const rlsEnabled = rlsMap.get(tableName) ?? false
            return (
              <Card key={tableName}>
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/40">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium text-foreground">storage.{tableName}</span>
                    <Badge variant={rlsEnabled ? "green" : "red"}>{rlsEnabled ? "RLS on" : "RLS off"}</Badge>
                  </div>
                  {sqlWrites ? (
                    <Button size="xs" variant={rlsEnabled ? "destructive" : "primary"} onClick={() => { void writes.toggleRls("storage", tableName, !rlsEnabled) }}>
                      {rlsEnabled ? "Disable RLS" : "Enable RLS"}
                    </Button>
                  ) : null}
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Policy</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Command</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Permissive</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Expression</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {tablePolicies?.map((p) => {
                      const qual = cellTextOrNull(p, "qual")
                      const withCheck = cellTextOrNull(p, "with_check")
                      const exprLabel = withCheck ? "WITH CHECK" : "USING"
                      const expr = withCheck ?? qual ?? "(none)"
                      const name = cellText(p, "policyname")
                      return (
                      <tr key={cellText(p, "policyname")} className="border-b border-border last:border-0">
                        <td className="px-4 py-2.5 font-mono text-xs text-foreground">{cellText(p, "policyname")}</td>
                        <td className="px-4 py-2.5"><Badge variant="blue">{cellText(p, "cmd")}</Badge></td>
                        <td className="px-4 py-2.5"><Badge variant={cellText(p, "permissive") === "PERMISSIVE" ? "green" : "yellow"}>{cellText(p, "permissive")}</Badge></td>
                        <td className="px-4 py-2.5">
                          <div className="inline-flex items-center gap-2">
                            <Badge variant="blue">{exprLabel}</Badge>
                            <code className="text-xs text-foreground">{expr}</code>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {sqlWrites ? (
                            <DropPolicyButton
                              policy={{ schema: "storage", table: tableName, name }}
                              drop={() => { void writes.dropPolicy("storage", tableName, name) }}
                            />
                          ) : null}
                        </td>
                      </tr>
                    )})}
                  </tbody>
                </table>
              </Card>
            )
          })}
        </div>
      )}

      <PolicyCreatePanel
        target={createTarget}
        onClose={(created) => { setCreateTarget(null); if (created) refresh() }}
      />

      {manualPolicyWarningOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 w-full max-w-xl space-y-4 shadow-xl">
            <h2 className="text-base font-semibold text-foreground">Manual policy warning</h2>
            <p className="text-sm text-muted-foreground">
              It is strongly recommended to define storage access policies in your schema so migrations
              remain reproducible and reviewable.
            </p>
            <p className="text-sm text-muted-foreground">
              If you create policies manually in Studio, you do so at your own risk. Manual policies may
              interact with generated policies in unexpected ways.
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setManualPolicyWarningOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setManualPolicyWarningOpen(false)
                  setCreateTarget(STORAGE_TARGET)
                }}
              >
                I understand, continue
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
