import React, { useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Badge, Button, Card } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"

const LIST_QUERY = (schema: string) => `
  SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
  FROM pg_policies
  WHERE schemaname = '${schema}'
  ORDER BY tablename, policyname
`

const RLS_STATUS_QUERY = (schema: string) => `
  SELECT t.tablename, c.relrowsecurity AS rls_enabled
  FROM pg_tables t
  JOIN pg_class c ON c.relname = t.tablename
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = '${schema}'
  WHERE t.schemaname = '${schema}'
  ORDER BY t.tablename
`

export function PoliciesView(): React.ReactElement {
  const proxy = useProjectProxy()
  const [schema, setSchema] = useState("public")
  const [createModal, setCreateModal] = useState(false)
  const [sqlText, setSqlText] = useState("")
  const [runError, setRunError] = useState<string | null>(null)
  const [runBusy, setRunBusy] = useState(false)

  const { data: schemas } = useApiQuery(() => proxy.schemas(), [proxy])
  const { data: policies, loading, error, refetch } = useApiQuery(
    () => proxy.sql(LIST_QUERY(schema)).then((r) => r.rows),
    [proxy, schema],
  )
  const { data: rlsStatus, refetch: refetchRls } = useApiQuery(
    () => proxy.sql(RLS_STATUS_QUERY(schema)).then((r) => r.rows),
    [proxy, schema],
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
      await proxy.sql(sqlText, schema)
      setCreateModal(false)
      refetch()
    } catch (e) {
      setRunError((e as Error).message)
    } finally {
      setRunBusy(false)
    }
  }

  async function toggleRls(table: string, enable: boolean) {
    try {
      await proxy.sql(`ALTER TABLE ${schema}.${table} ${enable ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY;`, schema)
      refetchRls()
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground">Policies</h1>
          <select value={schema} onChange={(e) => setSchema(e.target.value)} className="px-2 py-1 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none">
            {(schemas ?? ["public"]).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <Button variant="primary" onClick={() => {
          setSqlText(`CREATE POLICY my_policy ON ${schema}.my_table\n  AS PERMISSIVE\n  FOR ALL\n  TO authenticated\n  USING (true)\n  WITH CHECK (true);`)
          setCreateModal(true)
        }}>
          Create policy
        </Button>
      </div>

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}</div>
      ) : policies?.length === 0 ? (
        <EmptyState title="No policies" description={`No RLS policies found in schema "${schema}".`} />
      ) : (
        <div className="space-y-4">
          {Array.from(grouped.entries()).map(([tableName, tablePolicies]) => {
            const rlsEnabled = rlsMap.get(tableName) ?? false
            return (
              <Card key={tableName}>
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/40">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium text-foreground">{tableName}</span>
                    <Badge variant={rlsEnabled ? "green" : "red"}>{rlsEnabled ? "RLS on" : "RLS off"}</Badge>
                  </div>
                  <Button
                    size="xs"
                    variant={rlsEnabled ? "destructive" : "primary"}
                    onClick={() => { void toggleRls(tableName, !rlsEnabled) }}
                  >
                    {rlsEnabled ? "Disable RLS" : "Enable RLS"}
                  </Button>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Policy</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Command</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Permissive</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Roles</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {tablePolicies?.map((p) => (
                      <tr key={p["policyname"] as string} className="border-b border-border last:border-0">
                        <td className="px-4 py-2.5 font-mono text-xs text-foreground">{p["policyname"] as string}</td>
                        <td className="px-4 py-2.5"><Badge variant="blue">{p["cmd"] as string}</Badge></td>
                        <td className="px-4 py-2.5"><Badge variant={(p["permissive"] as string) === "PERMISSIVE" ? "green" : "yellow"}>{p["permissive"] as string}</Badge></td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{((p["roles"] as string[] | null) ?? []).join(", ") || "all"}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button type="button" className="text-xs text-destructive hover:underline" onClick={() => { setSqlText(`DROP POLICY ${p["policyname"] as string} ON ${schema}.${tableName};`); setCreateModal(true) }}>Drop</button>
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

      {createModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 w-full max-w-lg space-y-4 shadow-xl">
            <h2 className="text-base font-semibold text-foreground">SQL</h2>
            <textarea className="w-full font-mono text-sm px-3 py-2 rounded-md border border-border bg-background text-foreground focus:outline-none min-h-[140px] resize-y" value={sqlText} onChange={(e) => setSqlText(e.target.value)} />
            {runError && <p className="text-xs text-destructive">{runError}</p>}
            <div className="flex justify-end gap-2">
              <Button onClick={() => { setCreateModal(false); setRunError(null) }}>Cancel</Button>
              <Button variant="primary" disabled={runBusy} onClick={() => { void runSql() }}>{runBusy ? "Running…" : "Run SQL"}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
