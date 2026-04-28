import React, { useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Button, Card, CodeBlock } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { SlidePanel } from "../../components/SlidePanel.js"

const LIST_QUERY = (schema: string) => `
  SELECT table_name AS view_name, view_definition
  FROM information_schema.views
  WHERE table_schema = '${schema}'
  ORDER BY table_name
`

export function ViewsView(): React.ReactElement {
  const proxy = useProjectProxy()
  const [schema, setSchema] = useState("public")
  const [selected, setSelected] = useState<{ name: string; def: string } | null>(null)
  const [sqlModal, setSqlModal] = useState<{ mode: "create" | "drop"; name?: string } | null>(null)
  const [sqlText, setSqlText] = useState("")
  const [runError, setRunError] = useState<string | null>(null)
  const [runBusy, setRunBusy] = useState(false)

  const { data: schemas } = useApiQuery(() => proxy.schemas(), [proxy])
  const { data: views, loading, error, refetch } = useApiQuery(
    () => proxy.sql(LIST_QUERY(schema)).then((r) => r.rows),
    [proxy, schema],
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
          <h1 className="text-xl font-semibold text-foreground">Views</h1>
          <select value={schema} onChange={(e) => setSchema(e.target.value)} className="px-2 py-1 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none">
            {(schemas ?? ["public"]).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <Button variant="primary" onClick={() => { setSqlText(`CREATE VIEW ${schema}.new_view AS\nSELECT 1;`); setSqlModal({ mode: "create" }) }}>Create view</Button>
      </div>

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}</div>
      ) : views?.length === 0 ? (
        <EmptyState title="No views" description={`No views found in schema "${schema}".`} />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Definition</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {views?.map((row) => (
                <tr key={row["view_name"] as string} className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer" onClick={() => setSelected({ name: row["view_name"] as string, def: row["view_definition"] as string })}>
                  <td className="px-4 py-3 font-mono text-sm text-foreground">{row["view_name"] as string}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground truncate max-w-[400px]">{(row["view_definition"] as string)?.slice(0, 100)}…</td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <span className="flex items-center justify-end gap-3">
                      <button type="button" className="text-xs text-primary hover:underline" onClick={() => { setSqlText(`CREATE OR REPLACE VIEW ${schema}.${row["view_name"] as string} AS\n${row["view_definition"] as string}`); setSqlModal({ mode: "create" }) }}>Edit</button>
                      <button type="button" className="text-xs text-destructive hover:underline" onClick={() => { setSqlText(`DROP VIEW ${schema}.${row["view_name"] as string};`); setSqlModal({ mode: "drop", name: row["view_name"] as string }) }}>Drop</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <SlidePanel
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ""}
        subtitle={`${schema}.${selected?.name ?? ""}`}
        width="max-w-[540px]"
      >
        {selected && <CodeBlock>{selected.def}</CodeBlock>}
      </SlidePanel>

      {sqlModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 w-full max-w-lg space-y-4 shadow-xl">
            <h2 className="text-base font-semibold text-foreground">{sqlModal.mode === "drop" ? `Drop view ${sqlModal.name}` : "Create / replace view"}</h2>
            <textarea className="w-full font-mono text-sm px-3 py-2 rounded-md border border-border bg-background text-foreground focus:outline-none min-h-[120px] resize-y" value={sqlText} onChange={(e) => setSqlText(e.target.value)} />
            {runError && <p className="text-xs text-destructive">{runError}</p>}
            <div className="flex justify-end gap-2">
              <Button onClick={() => { setSqlModal(null); setRunError(null) }}>Cancel</Button>
              <Button variant={sqlModal.mode === "drop" ? "destructive" : "primary"} disabled={runBusy} onClick={() => { void runSql() }}>{runBusy ? "Running…" : "Run SQL"}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
