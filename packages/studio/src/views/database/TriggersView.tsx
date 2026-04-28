import React, { useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Badge, Button, Card, CodeBlock } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { SlidePanel } from "../../components/SlidePanel.js"

const LIST_QUERY = (schema: string) => `
  SELECT trigger_name, event_manipulation, event_object_table,
         action_timing, action_orientation, action_statement
  FROM information_schema.triggers
  WHERE trigger_schema = '${schema}'
  ORDER BY event_object_table, trigger_name
`

export function TriggersView(): React.ReactElement {
  const proxy = useProjectProxy()
  const [schema, setSchema] = useState("public")
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null)
  const [sqlModal, setSqlModal] = useState(false)
  const [sqlText, setSqlText] = useState("")
  const [runError, setRunError] = useState<string | null>(null)
  const [runBusy, setRunBusy] = useState(false)

  const { data: schemas } = useApiQuery(() => proxy.schemas(), [proxy])
  const { data: triggers, loading, error, refetch } = useApiQuery(
    () => proxy.sql(LIST_QUERY(schema)).then((r) => r.rows),
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
      setRunError((e as Error).message)
    } finally {
      setRunBusy(false)
    }
  }

  const timingVariant = (t: string) => t === "BEFORE" ? "yellow" as const : "blue" as const
  const eventVariant = (e: string) => ({ INSERT: "green" as const, UPDATE: "yellow" as const, DELETE: "red" as const })[e] ?? "blue" as const

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground">Triggers</h1>
          <select value={schema} onChange={(e) => setSchema(e.target.value)} className="px-2 py-1 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none">
            {(schemas ?? ["public"]).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <Button variant="primary" onClick={() => { setSqlText(`CREATE OR REPLACE TRIGGER my_trigger\nBEFORE INSERT ON ${schema}.my_table\nFOR EACH ROW EXECUTE FUNCTION my_function();`); setSqlModal(true) }}>Create trigger</Button>
      </div>

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}</div>
      ) : triggers?.length === 0 ? (
        <EmptyState title="No triggers" description={`No triggers found in schema "${schema}".`} />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Table</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Event</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Orientation</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {triggers?.map((row, i) => (
                <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer" onClick={() => setSelected(row)}>
                  <td className="px-4 py-3 font-mono text-sm text-foreground">{row["trigger_name"] as string}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs font-mono">{row["event_object_table"] as string}</td>
                  <td className="px-4 py-3 flex gap-1">
                    <Badge variant={timingVariant(row["action_timing"] as string)}>{row["action_timing"] as string}</Badge>
                    <Badge variant={eventVariant(row["event_manipulation"] as string)}>{row["event_manipulation"] as string}</Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{row["action_orientation"] as string}</td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="text-xs text-destructive hover:underline" onClick={() => { setSqlText(`DROP TRIGGER ${row["trigger_name"] as string} ON ${schema}.${row["event_object_table"] as string};`); setSqlModal(true) }}>Drop</button>
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
        title={(selected?.["trigger_name"] as string) ?? ""}
        subtitle={selected ? `${selected["action_timing"] as string} ${selected["event_manipulation"] as string} on ${selected["event_object_table"] as string}` : undefined}
        width="max-w-[540px]"
      >
        {selected && <CodeBlock>{(selected["action_statement"] as string) ?? ""}</CodeBlock>}
      </SlidePanel>

      {sqlModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 w-full max-w-lg space-y-4 shadow-xl">
            <h2 className="text-base font-semibold text-foreground">SQL</h2>
            <textarea className="w-full font-mono text-sm px-3 py-2 rounded-md border border-border bg-background text-foreground focus:outline-none min-h-[120px] resize-y" value={sqlText} onChange={(e) => setSqlText(e.target.value)} />
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
