import React, { useCallback, useState } from "react"
import { useNavigate } from "react-router-dom"
import type { AdminConfig } from "../../config.js"
import { useAdminConfig } from "../../hooks/useAdminConfig.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useSqlEditorOffered } from "../../hooks/useSqlEditorOffered.js"
import { useSchemaPicker } from "../../hooks/useSchemaPicker.js"
import { Button, PageHeader, Table, Td, Th, tableRowClass } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { SlidePanel } from "../../components/SlidePanel.js"
import { SchemaSelect } from "../../components/database/SchemaSelect.js"
import { SqlDraftDialog, useSqlDraft, type SqlDraft } from "../../components/database/SqlDraftDialog.js"
import { CatalogueTable, DropRowButton, RowActions, RowButton, useCatalogueRows } from "../../components/database/CatalogueTable.js"
import { qualifiedName, quoteIdent } from "../../lib/sql-identifier.js"
import { cellNumber, cellText, cellTextOrNull } from "../metadata-row.js"

type Row = Record<string, unknown>

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

/** Resolve schema config model name from a physical table name (handles qualified `schema.table`). */
function modelNameForTable(admin: AdminConfig, physicalTable: string): string | null {
  const m = admin.models.find((mo) => {
    const t = mo.tableName
    if (t === physicalTable) return true
    const dot = t.lastIndexOf(".")
    return dot !== -1 && t.slice(dot + 1) === physicalTable
  })
  return m?.name ?? null
}

/** Browse data for a table: its model's data view when a model maps it, else the raw data browser. */
function useBrowseData(): (physicalTable: string) => void {
  const admin = useAdminConfig()
  const navigate = useNavigate()
  return useCallback(
    (physicalTable: string) => {
      const modelName = modelNameForTable(admin, physicalTable)
      navigate(modelName !== null ? `/models/${modelName}/data` : `/data?table=${encodeURIComponent(physicalTable)}`)
    },
    [admin, navigate],
  )
}

/** What a row offers: open its columns, browse its data, and (for the SQL editor's roles) drop it. */
interface TableRowActions {
  select: (table: string) => void
  browse: (table: string) => void
  /** Drafts the drop for review; null for a role that may not write. */
  drop: ((table: string) => void) | null
}

export function TablesView(): React.ReactElement {
  // Writes go through the SQL editor's route, so only its roles are offered them (RQ4).
  const sqlWrites = useSqlEditorOffered()
  const picker = useSchemaPicker()
  const { schema } = picker
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const { data: tables, loading, error, refetch } = useCatalogueRows("tables", schema)
  const draft = useSqlDraft(schema, refetch)
  const browse = useBrowseData()
  const actions: TableRowActions = { select: setSelectedTable, browse, drop: sqlWrites ? (t) => { draftDrop(draft, schema, t) } : null }
  const create = <Button variant="primary" onClick={() => { draftCreate(draft, schema) }}>Create table</Button>
  return (
    <div className="space-y-4">
      <PageHeader title="Tables" scope={<SchemaSelect picker={picker} />} action={sqlWrites ? create : null} />
      {error && <ErrorBanner message={error} />}
      <CatalogueTable
        list={{ rows: tables, loading, empty: { title: "No tables", description: `No tables found in schema "${schema}".` } }}
        head={<><Th>Name</Th><Th>Rows (est.)</Th><Th>Size</Th><Th /></>}
        row={(row) => <TableRow key={cellText(row, "table_name")} row={row} actions={actions} />}
      />
      <ColumnsPanel schema={schema} table={selectedTable} onClose={() => { setSelectedTable(null) }} />
      <SqlDraftDialog draft={draft} />
    </div>
  )
}

function draftCreate(draft: SqlDraft, schema: string): void {
  draft.open(`CREATE TABLE ${quoteIdent(schema)}.new_table (\n  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY\n);`, "Create table")
}

function draftDrop(draft: SqlDraft, schema: string, table: string): void {
  draft.open(`DROP TABLE ${qualifiedName(schema, table)};`, `Drop table ${table}`)
}

function TableRow({ row, actions }: { row: Row; actions: TableRowActions }): React.ReactElement {
  const name = cellText(row, "table_name")
  const { drop } = actions
  return (
    <tr className={tableRowClass(true)} onClick={() => { actions.select(name) }}>
      <Td className="font-mono text-foreground">{name}</Td>
      <Td className="text-muted-foreground">{cellNumber(row, "row_estimate").toLocaleString()}</Td>
      <Td className="text-muted-foreground">{formatBytes(cellNumber(row, "bytes"))}</Td>
      <RowActions>
        <RowButton label="Browse data" onClick={() => { actions.browse(name) }} />
        {drop ? <DropRowButton onDrop={() => { drop(name) }} /> : null}
      </RowActions>
    </tr>
  )
}

/** The selected table's columns, in a panel over the list. */
function ColumnsPanel({ schema, table, onClose }: { schema: string; table: string | null; onClose: () => void }): React.ReactElement {
  const proxy = useProjectProxy()
  const { data: columns } = useApiQuery(
    () => table ? proxy.metadata("columns", { schema, table }).then((r) => r.rows) : Promise.resolve([]),
    [proxy, schema, table],
  )
  return (
    <SlidePanel open={table !== null} onClose={onClose} title={table ?? ""} subtitle={`${schema}.${table ?? ""}`} width="max-w-[420px]">
      <Table>
        <thead>
          <tr className="border-b border-border"><Th>Column</Th><Th>Type</Th><Th>Nullable</Th><Th>Default</Th></tr>
        </thead>
        <tbody>
          {(columns ?? []).map((col) => <ColumnRow key={cellText(col, "column_name")} col={col} />)}
        </tbody>
      </Table>
    </SlidePanel>
  )
}

function ColumnRow({ col }: { col: Row }): React.ReactElement {
  return (
    <tr className={tableRowClass(false)}>
      <Td className="font-mono text-xs text-foreground">{cellText(col, "column_name")}</Td>
      <Td className="text-xs text-muted-foreground">{cellText(col, "udt_name")}</Td>
      <Td className="text-xs">{col["is_nullable"] === "YES" ? "✓" : "-"}</Td>
      <Td className="text-xs text-muted-foreground font-mono truncate max-w-[100px]">{cellTextOrNull(col, "column_default") ?? "-"}</Td>
    </tr>
  )
}
