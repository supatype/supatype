import React, { useCallback, useId, useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useSqlEditorOffered } from "../../hooks/useSqlEditorOffered.js"
import { useSchemaPicker } from "../../hooks/useSchemaPicker.js"
import { Badge, Button, Card, Dialog, Input, PageHeader, Td, Th, tableRowClass } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { SchemaSelect } from "../../components/database/SchemaSelect.js"
import { CatalogueTable, DropRowButton, RowActions, useCatalogueRows } from "../../components/database/CatalogueTable.js"
import { qualifiedName } from "../../lib/sql-identifier.js"
import { cellText } from "../metadata-row.js"

type Row = Record<string, unknown>

/** Running a type's create or drop on the schema: whether one is running, and why the last failed. */
interface TypeWrites {
  busy: boolean
  error: string | null
  /** Runs `sql`, refetching the list when it succeeds; resolves to whether it did. */
  run: (sql: string) => Promise<boolean>
  clearError: () => void
}

function useTypeWrites(schema: string, refetch: () => void): TypeWrites {
  const proxy = useProjectProxy()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async (sql: string): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await proxy.sql(sql, schema)
      refetch()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }, [proxy, schema, refetch])
  const clearError = useCallback(() => { setError(null) }, [])
  return { busy, error, run, clearError }
}

/** The new enum's name and values as typed; kept while the form is closed, cleared once created. */
interface EnumDraft {
  name: string
  values: string
  setName: (name: string) => void
  setValues: (values: string) => void
  reset: () => void
}

function useEnumDraft(): EnumDraft {
  const [name, setName] = useState("")
  const [values, setValues] = useState("")
  const reset = useCallback(() => { setName(""); setValues("") }, [])
  return { name, values, setName, setValues, reset }
}

/** The CREATE TYPE statement for the draft in `schema`, or null while its name or values are blank. */
function createEnumSql(schema: string, draft: EnumDraft): string | null {
  if (!draft.name.trim() || !draft.values.trim()) return null
  const vals = draft.values.split(",").map((v) => `'${v.trim().replace(/'/g, "''")}'`).join(", ")
  return `CREATE TYPE ${qualifiedName(schema, draft.name.trim())} AS ENUM (${vals});`
}

export function TypesView(): React.ReactElement {
  // Writes go through the SQL editor's route, so only its roles are offered them (RQ4).
  const sqlWrites = useSqlEditorOffered()
  const picker = useSchemaPicker()
  const { schema } = picker
  const [showCreate, setShowCreate] = useState(false)
  const [dropping, setDropping] = useState<string | null>(null)
  const { data: types, loading, error, refetch } = useCatalogueRows("types", schema)
  const writes = useTypeWrites(schema, refetch)
  const draft = useEnumDraft()
  const create = <Button variant="primary" onClick={() => { setShowCreate(true) }}>Create enum</Button>
  return (
    <div className="space-y-4">
      <PageHeader title="Types" scope={<SchemaSelect picker={picker} />} action={sqlWrites ? create : null} />
      {error && <ErrorBanner message={error} />}
      {showCreate && <EnumForm form={{ schema, draft }} writes={writes} onClose={() => { setShowCreate(false) }} />}
      <CatalogueTable
        list={{ rows: types, loading, empty: { title: "No types", description: `No custom types found in schema "${schema}".` } }}
        head={<><Th>Name</Th><Th>Kind</Th><Th>Values</Th><Th /></>}
        row={(row) => <TypeRow key={cellText(row, "typname")} row={row} onDrop={sqlWrites ? setDropping : null} />}
      />
      {dropping && <DropTypeDialog type={{ schema, name: dropping }} writes={writes} onClose={() => { setDropping(null) }} />}
    </div>
  )
}

function TypeRow({ row, onDrop }: { row: Row; onDrop: ((name: string) => void) | null }): React.ReactElement {
  const isEnum = row["typtype"] === "e"
  const values = Array.isArray(row["enum_values"]) ? row["enum_values"].join(", ") : ""
  return (
    <tr className={tableRowClass(false)}>
      <Td className="font-mono text-foreground">{cellText(row, "typname")}</Td>
      <Td><Badge variant={isEnum ? "indigo" : "blue"}>{isEnum ? "enum" : "composite"}</Badge></Td>
      <Td className="text-xs text-muted-foreground">{values || "-"}</Td>
      <RowActions>{onDrop ? <DropRowButton onDrop={() => { onDrop(cellText(row, "typname")) }} /> : null}</RowActions>
    </tr>
  )
}

/** The new enum type form: its name, its comma-separated values, and Create. */
function EnumForm({ form, writes, onClose }: { form: { schema: string; draft: EnumDraft }; writes: TypeWrites; onClose: () => void }): React.ReactElement {
  const { schema, draft } = form
  const submit = async (): Promise<void> => {
    const sql = createEnumSql(schema, draft)
    if (sql === null) return
    if (await writes.run(sql)) { onClose(); draft.reset() }
  }
  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-sm font-medium text-foreground">New enum type</h3>
      <div className="flex flex-col gap-2 sm:flex-row">
        <LabelledInput field={{ label: "Name", placeholder: "my_status" }} value={draft.name} onChange={draft.setName} />
        <LabelledInput field={{ label: "Values (comma-separated)", placeholder: "draft, published, archived" }} value={draft.values} onChange={draft.setValues} />
      </div>
      {writes.error && <p className="text-xs text-destructive-text">{writes.error}</p>}
      <div className="flex gap-2">
        <Button variant="primary" disabled={writes.busy} onClick={() => { void submit() }}>{writes.busy ? "Creating…" : "Create"}</Button>
        <Button onClick={() => { onClose(); writes.clearError() }}>Cancel</Button>
      </div>
    </Card>
  )
}

/** A shared {@link Input} under its label, taking an equal share of the row it sits in. */
function LabelledInput({ field, value, onChange }: {
  field: { label: string; placeholder: string }
  value: string
  onChange: (value: string) => void
}): React.ReactElement {
  const id = useId()
  const { label, placeholder } = field
  return (
    <div className="flex-1 min-w-0">
      <label htmlFor={id} className="block text-xs text-muted-foreground mb-1">{label}</label>
      <Input id={id} value={value} onChange={(e) => { onChange(e.target.value) }} placeholder={placeholder} />
    </div>
  )
}

/** Asks before dropping a type, and shows why the drop failed when it does. */
function DropTypeDialog({ type, writes, onClose }: { type: { schema: string; name: string }; writes: TypeWrites; onClose: () => void }): React.ReactElement {
  const drop = async (): Promise<void> => {
    if (await writes.run(`DROP TYPE ${qualifiedName(type.schema, type.name)};`)) onClose()
  }
  const actions = (
    <>
      <Button onClick={() => { onClose(); writes.clearError() }}>Cancel</Button>
      <Button variant="destructive" disabled={writes.busy} onClick={() => { void drop() }}>{writes.busy ? "Dropping…" : "Drop"}</Button>
    </>
  )
  return (
    <Dialog role="alertdialog" title={`Drop type ${type.name}?`} actions={actions}>
      <p>This will fail if any column or function references this type.</p>
      {writes.error && <p className="text-xs text-destructive-text">{writes.error}</p>}
    </Dialog>
  )
}
