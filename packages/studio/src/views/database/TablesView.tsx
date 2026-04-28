import React, { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Button, Card } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { SlidePanel } from "../../components/SlidePanel.js"

const LIST_QUERY = (schema: string) => `
  SELECT
    t.table_name,
    c.reltuples::bigint AS row_estimate,
    pg_total_relation_size(quote_ident('${schema}') || '.' || quote_ident(t.table_name))::bigint AS bytes
  FROM information_schema.tables t
  JOIN pg_class c ON c.relname = t.table_name
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = '${schema}'
  WHERE t.table_schema = '${schema}' AND t.table_type = 'BASE TABLE'
  ORDER BY t.table_name
`

const COLUMNS_QUERY = (schema: string, table: string) => `
  SELECT column_name, udt_name, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = '${schema}' AND table_name = '${table}'
  ORDER BY ordinal_position
`

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

export function TablesView(): React.ReactElement {
  const proxy = useProjectProxy()
  const navigate = useNavigate()
  const [schema, setSchema] = useState("public")
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [sqlModal, setSqlModal] = useState<{ mode: "create" | "drop"; table?: string } | null>(null)
  const [sqlText, setSqlText] = useState("")
  const [runError, setRunError] = useState<string | null>(null)
  const [runBusy, setRunBusy] = useState(false)

  const { data: schemas } = useApiQuery(() => proxy.schemas(), [proxy])
  const { data: tables, loading, error, refetch } = useApiQuery(
    () => proxy.sql(LIST_QUERY(schema)).then((r) => r.rows),
    [proxy, schema],
  )
  const { data: columns } = useApiQuery(
    () => selectedTable ? proxy.sql(COLUMNS_QUERY(schema, selectedTable)).then((r) => r.rows) : Promise.resolve([]),
    [proxy, schema, selectedTable],
  )

  async function runSql() {
    setRunBusy(true)
    setRunError(null)
    try {
      await proxy.sql(sqlText, schema)
      setSqlModal(null)
      refetch()
    } catch (e) {
      setRunError((e as Error).message)
    } finally {
      setRunBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground">Tables</h1>
          <select
            value={schema}
            onChange={(e) => setSchema(e.target.value)}
            className="px-2 py-1 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none"
          >
            {(schemas ?? ["public"]).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <Button
          variant="primary"
         
          onClick={() => {
            setSqlText(`CREATE TABLE ${schema}.new_table (\n  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY\n);`)
            setSqlModal({ mode: "create" })
          }}
        >
          Create table
        </Button>
      </div>

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}
        </div>
      ) : tables?.length === 0 ? (
        <EmptyState title="No tables" description={`No tables found in schema "${schema}".`} />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Rows (est.)</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Size</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {tables?.map((row) => (
                <tr
                  key={row["table_name"] as string}
                  className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                  onClick={() => setSelectedTable(row["table_name"] as string)}
                >
                  <td className="px-4 py-3 font-mono text-sm text-foreground">{row["table_name"] as string}</td>
                  <td className="px-4 py-3 text-muted-foreground">{(row["row_estimate"] as number).toLocaleString()}</td>
                  <td className="px-4 py-3 text-muted-foreground">{formatBytes(row["bytes"] as number)}</td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <span className="flex items-center justify-end gap-3">
                      <button type="button" className="text-xs text-primary hover:underline" onClick={() => navigate(`/data?table=${row["table_name"] as string}`)}>Browse data</button>
                      <button type="button" className="text-xs text-destructive hover:underline" onClick={() => { setSqlText(`DROP TABLE ${schema}.${row["table_name"] as string};`); setSqlModal({ mode: "drop", table: row["table_name"] as string }) }}>Drop</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Column details panel */}
      <SlidePanel
        open={selectedTable !== null}
        onClose={() => setSelectedTable(null)}
        title={selectedTable ?? ""}
        subtitle={`${schema}.${selectedTable ?? ""}`}
        width="max-w-[420px]"
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="text-left pb-2">Column</th>
              <th className="text-left pb-2">Type</th>
              <th className="text-left pb-2">Nullable</th>
              <th className="text-left pb-2">Default</th>
            </tr>
          </thead>
          <tbody>
            {(columns ?? []).map((col) => (
              <tr key={col["column_name"] as string} className="border-b border-border last:border-0">
                <td className="py-2 font-mono text-xs text-foreground">{col["column_name"] as string}</td>
                <td className="py-2 text-xs text-muted-foreground">{col["udt_name"] as string}</td>
                <td className="py-2 text-xs">{col["is_nullable"] === "YES" ? "✓" : "—"}</td>
                <td className="py-2 text-xs text-muted-foreground font-mono truncate max-w-[100px]">{(col["column_default"] as string | null) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SlidePanel>

      {/* SQL modal */}
      {sqlModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 w-full max-w-lg space-y-4 shadow-xl">
            <h2 className="text-base font-semibold text-foreground">
              {sqlModal.mode === "drop" ? `Drop table ${sqlModal.table}` : "Create table"}
            </h2>
            <textarea
              className="w-full font-mono text-sm px-3 py-2 rounded-md border border-border bg-background text-foreground focus:outline-none min-h-[120px] resize-y"
              value={sqlText}
              onChange={(e) => setSqlText(e.target.value)}
            />
            {runError && <p className="text-xs text-destructive">{runError}</p>}
            <div className="flex justify-end gap-2">
              <Button onClick={() => { setSqlModal(null); setRunError(null) }}>Cancel</Button>
              <Button variant={sqlModal.mode === "drop" ? "destructive" : "primary"} disabled={runBusy} onClick={() => { void runSql() }}>
                {runBusy ? "Running…" : "Run SQL"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
