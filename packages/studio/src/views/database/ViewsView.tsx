import React, { useState } from "react"
import { useSqlEditorOffered } from "../../hooks/useSqlEditorOffered.js"
import { useSchemaPicker } from "../../hooks/useSchemaPicker.js"
import { Button, CodeBlock, PageHeader, Td, Th, tableRowClass } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { SlidePanel } from "../../components/SlidePanel.js"
import { SchemaSelect } from "../../components/database/SchemaSelect.js"
import { SqlDraftDialog, useSqlDraft, type SqlDraft } from "../../components/database/SqlDraftDialog.js"
import { CatalogueTable, DropRowButton, RowActions, RowButton, useCatalogueRows } from "../../components/database/CatalogueTable.js"
import { qualifiedName, quoteIdent } from "../../lib/sql-identifier.js"
import { cellText, cellTextOrNull } from "../metadata-row.js"

type Row = Record<string, unknown>

/** A view by name, and the query that defines it. */
interface ViewDef {
  name: string
  def: string
}

/** How a create, edit or replace draft is headed. */
const REPLACE_TITLE = "Create / replace view"

/** What a row offers: open its definition, and (for the SQL editor's roles) edit or drop it. */
interface ViewRowActions {
  select: (view: ViewDef) => void
  /** Drafts an edit or a drop for review; null for a role that may not write. */
  writes: { edit: (view: ViewDef) => void; drop: (view: ViewDef) => void } | null
}

/** The edit and drop drafts for views in `schema`. */
function viewWrites(draft: SqlDraft, schema: string): NonNullable<ViewRowActions["writes"]> {
  return {
    edit: (v) => { draft.open(`CREATE OR REPLACE VIEW ${qualifiedName(schema, v.name)} AS\n${v.def}`, REPLACE_TITLE) },
    drop: (v) => { draft.open(`DROP VIEW ${qualifiedName(schema, v.name)};`, `Drop view ${v.name}`) },
  }
}

export function ViewsView(): React.ReactElement {
  // Writes go through the SQL editor's route, so only its roles are offered them (RQ4).
  const sqlWrites = useSqlEditorOffered()
  const picker = useSchemaPicker()
  const { schema } = picker
  const [selected, setSelected] = useState<ViewDef | null>(null)
  const { data: views, loading, error, refetch } = useCatalogueRows("views", schema)
  const draft = useSqlDraft(schema, refetch)
  const actions: ViewRowActions = { select: setSelected, writes: sqlWrites ? viewWrites(draft, schema) : null }
  const create = <Button variant="primary" onClick={() => { draft.open(`CREATE VIEW ${quoteIdent(schema)}.new_view AS\nSELECT 1;`, REPLACE_TITLE) }}>Create view</Button>
  return (
    <div className="space-y-4">
      <PageHeader title="Views" scope={<SchemaSelect picker={picker} />} action={sqlWrites ? create : null} />
      {error && <ErrorBanner message={error} />}
      <CatalogueTable
        list={{ rows: views, loading, empty: { title: "No views", description: `No views found in schema "${schema}".` } }}
        head={<><Th>Name</Th><Th>Definition</Th><Th /></>}
        row={(row) => <ViewRow key={cellText(row, "view_name")} row={row} actions={actions} />}
      />
      <SlidePanel open={selected !== null} onClose={() => { setSelected(null) }} title={selected?.name ?? ""} subtitle={`${schema}.${selected?.name ?? ""}`} width="max-w-[540px]">
        {selected && <CodeBlock>{selected.def}</CodeBlock>}
      </SlidePanel>
      <SqlDraftDialog draft={draft} />
    </div>
  )
}

function ViewRow({ row, actions }: { row: Row; actions: ViewRowActions }): React.ReactElement {
  const view: ViewDef = { name: cellText(row, "view_name"), def: cellText(row, "view_definition") }
  const { writes } = actions
  return (
    <tr className={tableRowClass(true)} onClick={() => { actions.select(view) }}>
      <Td className="font-mono text-foreground">{view.name}</Td>
      <Td className="text-xs text-muted-foreground truncate max-w-[400px]">{cellTextOrNull(row, "view_definition")?.slice(0, 100)}…</Td>
      <RowActions>
        {writes ? <RowButton label="Edit" onClick={() => { writes.edit(view) }} /> : null}
        {writes ? <DropRowButton onDrop={() => { writes.drop(view) }} /> : null}
      </RowActions>
    </tr>
  )
}
