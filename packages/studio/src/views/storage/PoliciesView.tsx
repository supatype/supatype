import React, { useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Badge, Button, Card } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"

const LIST_QUERY = `
  SELECT policyname, tablename, cmd, permissive, roles, qual, with_check
  FROM pg_policies
  WHERE schemaname = 'storage' AND tablename IN ('objects', 'buckets')
  ORDER BY tablename, policyname
`

const RLS_STATUS_QUERY = `
  SELECT t.tablename, c.relrowsecurity AS rls_enabled
  FROM pg_tables t
  JOIN pg_class c ON c.relname = t.tablename
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'storage'
  WHERE t.schemaname = 'storage' AND t.tablename IN ('objects', 'buckets')
  ORDER BY t.tablename
`

export function StoragePoliciesView(): React.ReactElement {
  const proxy = useProjectProxy()
  const [sqlModal, setSqlModal] = useState(false)
  const [sqlText, setSqlText] = useState("")
  const [runError, setRunError] = useState<string | null>(null)
  const [runBusy, setRunBusy] = useState(false)

  const { data: policies, loading, error, refetch } = useApiQuery(
    () => proxy.sql(LIST_QUERY).then((r) => r.rows),
    [proxy],
  )
  const { data: rlsStatus, refetch: refetchRls } = useApiQuery(
    () => proxy.sql(RLS_STATUS_QUERY).then((r) => r.rows),
    [proxy],
  )

  const rlsMap = new Map((rlsStatus ?? []).map((r) => [r["tablename"] as string, r["rls_enabled"] as boolean]))

  const grouped = new Map<string, typeof policies>()
  for (const p of policies ?? []) {
    const t = p["tablename"] as string
    if (!grouped.has(t)) grouped.set(t, [])
    grouped.get(t)!.push(p)
  }

  async function runSql() {
    setRunBusy(true)
    setRunError(null)
    try {
      await proxy.sql(sqlText)
      setSqlModal(false)
      refetch()
    } catch (e) {
      setRunError((e as Error).message)
    } finally {
      setRunBusy(false)
    }
  }

  async function toggleRls(table: string, enable: boolean) {
    try {
      await proxy.sql(`ALTER TABLE storage.${table} ${enable ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY;`)
      refetchRls()
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Storage Policies</h1>
        <Button variant="primary" onClick={() => {
          setSqlText(`CREATE POLICY allow_public_read ON storage.objects\n  FOR SELECT\n  USING (bucket_id = 'public');`)
          setSqlModal(true)
        }}>
          Create policy
        </Button>
      </div>

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}</div>
      ) : policies?.length === 0 ? (
        <EmptyState title="No storage policies" description="No RLS policies found on storage tables." />
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
                  <Button size="xs" variant={rlsEnabled ? "destructive" : "primary"} onClick={() => { void toggleRls(tableName, !rlsEnabled) }}>
                    {rlsEnabled ? "Disable RLS" : "Enable RLS"}
                  </Button>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Policy</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Command</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Permissive</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {tablePolicies?.map((p) => (
                      <tr key={p["policyname"] as string} className="border-b border-border last:border-0">
                        <td className="px-4 py-2.5 font-mono text-xs text-foreground">{p["policyname"] as string}</td>
                        <td className="px-4 py-2.5"><Badge variant="blue">{p["cmd"] as string}</Badge></td>
                        <td className="px-4 py-2.5"><Badge variant={(p["permissive"] as string) === "PERMISSIVE" ? "green" : "yellow"}>{p["permissive"] as string}</Badge></td>
                        <td className="px-4 py-2.5 text-right">
                          <button type="button" className="text-xs text-destructive hover:underline" onClick={() => { setSqlText(`DROP POLICY ${p["policyname"] as string} ON storage.${tableName};`); setSqlModal(true) }}>Drop</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )
          })}
        </div>
      )}

      {sqlModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 w-full max-w-lg space-y-4 shadow-xl">
            <h2 className="text-base font-semibold text-foreground">SQL</h2>
            <textarea className="w-full font-mono text-sm px-3 py-2 rounded-md border border-border bg-background text-foreground focus:outline-none min-h-[140px] resize-y" value={sqlText} onChange={(e) => setSqlText(e.target.value)} />
            {runError && <p className="text-xs text-destructive">{runError}</p>}
            <div className="flex justify-end gap-2">
              <Button onClick={() => { setSqlModal(false); setRunError(null) }}>Cancel</Button>
              <Button variant="primary" disabled={runBusy} onClick={() => { void runSql() }}>{runBusy ? "Running…" : "Run SQL"}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
