import React, { useMemo, useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Badge, Button, Card } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"

/** Match server-side identifier rules so schema hints stay safe in SQL text. */
function safeSchemaName(schema: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) return "public"
  // pg_catalog stores unquoted schema names lowercased — fold so we match information_schema + pg_policies.
  return schema.toLowerCase()
}

function rowText(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k]
    if (v !== undefined && v !== null) return String(v)
  }
  for (const [k, v] of Object.entries(row)) {
    for (const want of keys) {
      if (k.toLowerCase() === want.toLowerCase() && v !== undefined && v !== null) return String(v)
    }
  }
  return ""
}

function normalizePolicyRows(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[]
  return []
}

function describeAppliesTo(row: Record<string, unknown>): string {
  const cmd = rowText(row, "cmd").toUpperCase()
  const withCheck = rowText(row, "with_check")
  const qual = rowText(row, "qual")
  const expr = (withCheck || qual || "").trim()
  const low = expr.toLowerCase()

  if (expr === "" || low === "true") return "Public"
  if (low === "false") return "No one"
  if (low.includes("auth.uid() is not null")) return "Logged in"

  const ownerMatch = expr.match(/auth\.uid\(\)\s*=\s*([a-zA-Z_][a-zA-Z0-9_]*)/)
  if (ownerMatch) return `Owner (${ownerMatch[1]})`

  const roleSingleMatch = expr.match(/auth\.role\(\)\s*=\s*'([^']+)'/)
  if (roleSingleMatch) return `Role: ${roleSingleMatch[1]}`

  const roleAnyMatch = expr.match(/auth\.role\(\)\s*=\s*ANY\(ARRAY\[(.+)\]\)/i)
  if (roleAnyMatch) {
    const roleList = roleAnyMatch[1] ?? ""
    const roles = Array.from(roleList.matchAll(/'([^']+)'/g)).map((m) => m[1]).filter((r): r is string => typeof r === "string")
    if (roles.length > 0) return `Roles: ${roles.join(", ")}`
  }

  if (cmd === "INSERT" && withCheck) return "Custom (insert check)"
  return "Custom"
}

const LIST_QUERY = (schema: string) => `
  SELECT schemaname, tablename, policyname, permissive, cmd, qual, with_check,
    CASE
      WHEN COALESCE(array_length(roles, 1), 0) = 0 THEN 'all'
      ELSE array_to_string(roles::text[], ', ')
    END AS roles_label
  FROM pg_catalog.pg_policies
  WHERE lower(schemaname) = lower('${schema}')
  ORDER BY tablename, policyname
`

const RLS_STATUS_QUERY = (schema: string) => `
  SELECT t.tablename, c.relrowsecurity AS rls_enabled
  FROM pg_catalog.pg_tables t
  JOIN pg_catalog.pg_class c ON c.relname = t.tablename
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND lower(n.nspname) = lower('${schema}')
  WHERE lower(t.schemaname) = lower('${schema}')
  ORDER BY t.tablename
`

export function PoliciesView(): React.ReactElement {
  const proxy = useProjectProxy()
  const [schema, setSchema] = useState("public")
  const schemaSql = useMemo(() => safeSchemaName(schema), [schema])
  const [createModal, setCreateModal] = useState(false)
  const [manualPolicyWarningOpen, setManualPolicyWarningOpen] = useState(false)
  const [sqlText, setSqlText] = useState("")
  const [runError, setRunError] = useState<string | null>(null)
  const [runBusy, setRunBusy] = useState(false)

  const { data: schemas } = useApiQuery(() => proxy.schemas(), [proxy])
  const { data: policies, loading, error, refetch } = useApiQuery(
    () => proxy.sql(LIST_QUERY(schemaSql)).then((r) => r.rows),
    [proxy, schemaSql],
  )
  const { data: rlsStatus } = useApiQuery(
    () => proxy.sql(RLS_STATUS_QUERY(schemaSql)).then((r) => r.rows),
    [proxy, schemaSql],
  )

  const policyRows = useMemo(() => normalizePolicyRows(policies), [policies])

  const rlsMap = useMemo(() => {
    const rows = Array.isArray(rlsStatus) ? rlsStatus : []
    return new Map(rows.map((r) => [rowText(r as Record<string, unknown>, "tablename"), (r as Record<string, unknown>)["rls_enabled"] === true || (r as Record<string, unknown>)["rls_enabled"] === "t"]))
  }, [rlsStatus])

  const grouped = useMemo(() => {
    const m = new Map<string, Record<string, unknown>[]>()
    for (const p of policyRows) {
      const t = rowText(p, "tablename") || "(unknown)"
      if (!m.has(t)) m.set(t, [])
      m.get(t)!.push(p)
    }
    return m
  }, [policyRows])

  async function runSql() {
    setRunBusy(true)
    setRunError(null)
    try {
      await proxy.sql(sqlText, schemaSql)
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
      await proxy.sql(`ALTER TABLE ${schemaSql}.${table} ${enable ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY;`, schemaSql)
      refetch()
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
        <Button variant="primary" onClick={() => { setManualPolicyWarningOpen(true) }}>
          Create policy
        </Button>
      </div>

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}</div>
      ) : policyRows.length === 0 ? (
        <EmptyState title="No policies" description={`No RLS policies found in schema "${schemaSql}".`} />
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
                <table className="w-full text-sm table-fixed">
                  <colgroup>
                    <col className="w-[18%]" />
                    <col className="w-[10%]" />
                    <col className="w-[14%]" />
                    <col className="w-[36%]" />
                    <col className="w-[12%]" />
                    <col className="w-[10%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Policy</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Command</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Permissive</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Expression</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Applies to</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {tablePolicies?.map((p, rowIdx) => {
                      const pname = rowText(p, "policyname")
                      const withCheck = rowText(p, "with_check")
                      const qual = rowText(p, "qual")
                      const exprLabel = withCheck ? "WITH CHECK" : "USING"
                      const expr = withCheck || qual || "(none)"
                      return (
                      <tr key={`${pname || "policy"}-${rowIdx}`} className="border-b border-border last:border-0">
                        <td className="px-4 py-2.5 font-mono text-xs text-foreground">{pname || "—"}</td>
                        <td className="px-4 py-2.5"><Badge variant="blue">{rowText(p, "cmd") || "—"}</Badge></td>
                        <td className="px-4 py-2.5"><Badge variant={rowText(p, "permissive") === "PERMISSIVE" ? "green" : "yellow"}>{rowText(p, "permissive") || "—"}</Badge></td>
                        <td className="px-4 py-2.5">
                          <div className="inline-flex items-center gap-2">
                            <Badge variant="blue">{exprLabel}</Badge>
                            <code className="text-xs text-foreground truncate max-w-full inline-block align-middle">{expr}</code>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{describeAppliesTo(p)}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button type="button" className="text-xs text-destructive hover:underline" onClick={() => { setSqlText(`DROP POLICY ${pname} ON ${schemaSql}.${tableName};`); setCreateModal(true) }}>Drop</button>
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

      {manualPolicyWarningOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 w-full max-w-xl space-y-4 shadow-xl">
            <h2 className="text-base font-semibold text-foreground">Manual policy warning</h2>
            <p className="text-sm text-muted-foreground">
              It is strongly recommended to define row-level security policies in your schema so migrations
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
                  setSqlText(`CREATE POLICY my_policy ON ${schemaSql}.my_table\n  AS PERMISSIVE\n  FOR ALL\n  TO authenticated\n  USING (true)\n  WITH CHECK (true);`)
                  setCreateModal(true)
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
