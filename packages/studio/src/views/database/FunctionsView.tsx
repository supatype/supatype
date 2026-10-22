import React, { useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useSqlEditorOffered } from "../../hooks/useSqlEditorOffered.js"
import { useSchemaPicker } from "../../hooks/useSchemaPicker.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Badge, Button, Card, CodeBlock } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { SlidePanel } from "../../components/SlidePanel.js"
import { cellText, cellTextOrNull } from "../metadata-row.js"

export function FunctionsView(): React.ReactElement {
  const proxy = useProjectProxy()
  // Writes go through the SQL editor's route, so only its roles are offered them (RQ4).
  const sqlWrites = useSqlEditorOffered()
  const { schemas, schema, setSchema } = useSchemaPicker()
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null)
  const [sqlModal, setSqlModal] = useState(false)
  const [sqlText, setSqlText] = useState("")
  const [runError, setRunError] = useState<string | null>(null)
  const [runBusy, setRunBusy] = useState(false)

  const { data: fns, loading, error, refetch } = useApiQuery(
    () => proxy.metadata("functions", { schema }).then((r) => r.rows),
    [proxy, schema],
  )

  async function runSql() {
    setRunBusy(true)
    setRunError(null)
    try {
      await proxy.sql(sqlText, schema)
      setSqlModal(false)
      refetch()
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground">Functions</h1>
          <select value={schema} onChange={(e) => setSchema(e.target.value)} className="px-2 py-1 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none">
            {(schemas.length > 0 ? schemas : [schema]).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {sqlWrites ? (<Button variant="primary" onClick={() => { setSqlText(`CREATE OR REPLACE FUNCTION ${schema}.my_function()\nRETURNS void\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- body\nEND;\n$$;`); setSqlModal(true) }}>Create function</Button>) : null}
      </div>

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}</div>
      ) : fns?.length === 0 ? (
        <EmptyState title="No functions" description={`No functions found in schema "${schema}".`} />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Returns</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Language</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {fns?.map((row, i) => (
                <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer" onClick={() => setSelected(row)}>
                  <td className="px-4 py-3 font-mono text-sm text-foreground">{cellText(row, "routine_name")}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{cellText(row, "return_type")}</td>
                  <td className="px-4 py-3"><Badge variant="blue">{cellTextOrNull(row, "language")?.toLowerCase()}</Badge></td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    {sqlWrites ? (<button type="button" className="text-xs text-destructive-text hover:underline" onClick={() => { setSqlText(`DROP FUNCTION ${schema}.${cellText(row, "routine_name")}();`); setSqlModal(true) }}>Drop</button>) : null}
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
        title={selected ? cellText(selected, "routine_name") : ""}
        subtitle={selected ? `${cellTextOrNull(selected, "language")?.toLowerCase()} · returns ${cellText(selected, "return_type")}` : undefined}
        width="max-w-[540px]"
      >
        {selected && <CodeBlock>{cellTextOrNull(selected, "routine_definition") ?? "(no definition)"}</CodeBlock>}
      </SlidePanel>

      {sqlModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 w-full max-w-lg space-y-4 shadow-xl">
            <h2 className="text-base font-semibold text-foreground">SQL</h2>
            <textarea className="w-full font-mono text-sm px-3 py-2 rounded-md border border-border bg-background text-foreground focus:outline-none min-h-[160px] resize-y" value={sqlText} onChange={(e) => setSqlText(e.target.value)} />
            {runError && <p className="text-xs text-destructive-text">{runError}</p>}
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
