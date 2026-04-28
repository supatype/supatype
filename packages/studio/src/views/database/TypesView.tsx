import React, { useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Badge, Button, Card } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"

const LIST_QUERY = (schema: string) => `
  SELECT t.typname, t.typtype,
    array_agg(e.enumlabel ORDER BY e.enumsortorder) FILTER (WHERE t.typtype = 'e') AS enum_values
  FROM pg_type t
  LEFT JOIN pg_enum e ON e.enumtypid = t.oid
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = '${schema}'
    AND t.typtype IN ('e','c')
    AND t.typname NOT LIKE '\\_%'
  GROUP BY t.typname, t.typtype
  ORDER BY t.typname
`

export function TypesView(): React.ReactElement {
  const proxy = useProjectProxy()
  const [schema, setSchema] = useState("public")
  const [newEnumName, setNewEnumName] = useState("")
  const [newEnumValues, setNewEnumValues] = useState("")
  const [showCreate, setShowCreate] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [runBusy, setRunBusy] = useState(false)
  const [dropModal, setDropModal] = useState<string | null>(null)

  const { data: schemas } = useApiQuery(() => proxy.schemas(), [proxy])
  const { data: types, loading, error, refetch } = useApiQuery(
    () => proxy.sql(LIST_QUERY(schema)).then((r) => r.rows),
    [proxy, schema],
  )

  async function createEnum() {
    if (!newEnumName.trim() || !newEnumValues.trim()) return
    const vals = newEnumValues.split(",").map((v) => `'${v.trim().replace(/'/g, "''")}'`).join(", ")
    setRunBusy(true)
    setRunError(null)
    try {
      await proxy.sql(`CREATE TYPE ${schema}.${newEnumName.trim()} AS ENUM (${vals});`, schema)
      setShowCreate(false)
      setNewEnumName("")
      setNewEnumValues("")
      refetch()
    } catch (e) {
      setRunError((e as Error).message)
    } finally {
      setRunBusy(false)
    }
  }

  async function dropType(name: string) {
    setRunBusy(true)
    setRunError(null)
    try {
      await proxy.sql(`DROP TYPE ${schema}.${name};`, schema)
      setDropModal(null)
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
          <h1 className="text-xl font-semibold text-foreground">Types</h1>
          <select value={schema} onChange={(e) => setSchema(e.target.value)} className="px-2 py-1 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none">
            {(schemas ?? ["public"]).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <Button variant="primary" onClick={() => setShowCreate(true)}>Create enum</Button>
      </div>

      {error && <ErrorBanner message={error} />}

      {showCreate && (
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-medium text-foreground">New enum type</h3>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-xs text-muted-foreground mb-1">Name</label>
              <input value={newEnumName} onChange={(e) => setNewEnumName(e.target.value)} className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-sm focus:outline-none" placeholder="my_status" />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-muted-foreground mb-1">Values (comma-separated)</label>
              <input value={newEnumValues} onChange={(e) => setNewEnumValues(e.target.value)} className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-sm focus:outline-none" placeholder="draft, published, archived" />
            </div>
          </div>
          {runError && <p className="text-xs text-destructive">{runError}</p>}
          <div className="flex gap-2">
            <Button variant="primary" disabled={runBusy} onClick={() => { void createEnum() }}>{runBusy ? "Creating…" : "Create"}</Button>
            <Button onClick={() => { setShowCreate(false); setRunError(null) }}>Cancel</Button>
          </div>
        </Card>
      )}

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}</div>
      ) : types?.length === 0 ? (
        <EmptyState title="No types" description={`No custom types found in schema "${schema}".`} />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Kind</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Values</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {types?.map((row) => (
                <tr key={row["typname"] as string} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-mono text-sm text-foreground">{row["typname"] as string}</td>
                  <td className="px-4 py-3">
                    <Badge variant={row["typtype"] === "e" ? "indigo" : "blue"}>{row["typtype"] === "e" ? "enum" : "composite"}</Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{((row["enum_values"] as string[] | null) ?? []).join(", ") || "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" className="text-xs text-destructive hover:underline" onClick={() => setDropModal(row["typname"] as string)}>Drop</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {dropModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg p-6 w-full max-w-sm space-y-4 shadow-xl">
            <h2 className="text-base font-semibold text-foreground">Drop type {dropModal}?</h2>
            <p className="text-sm text-muted-foreground">This will fail if any column or function references this type.</p>
            {runError && <p className="text-xs text-destructive">{runError}</p>}
            <div className="flex justify-end gap-2">
              <Button onClick={() => { setDropModal(null); setRunError(null) }}>Cancel</Button>
              <Button variant="destructive" disabled={runBusy} onClick={() => { void dropType(dropModal) }}>{runBusy ? "Dropping…" : "Drop"}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
