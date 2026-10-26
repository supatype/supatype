import React, { useState } from "react"
import { useSqlEditorOffered } from "../../hooks/useSqlEditorOffered.js"
import { useSchemaPicker } from "../../hooks/useSchemaPicker.js"
import { Badge, Button, CodeBlock, PageHeader, Td, Th, tableRowClass } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { SlidePanel } from "../../components/SlidePanel.js"
import { SchemaSelect } from "../../components/database/SchemaSelect.js"
import { SqlDraftDialog, useSqlDraft } from "../../components/database/SqlDraftDialog.js"
import { CatalogueTable, DropRowButton, RowActions, useCatalogueRows } from "../../components/database/CatalogueTable.js"
import { qualifiedName, quoteIdent } from "../../lib/sql-identifier.js"
import { cellText, cellTextOrNull } from "../metadata-row.js"

type Row = Record<string, unknown>

/** What a row offers: open its definition, and (for the SQL editor's roles) drop it. */
interface FunctionRowActions {
  select: (row: Row) => void
  /** Drafts the drop for review; null for a role that may not write. */
  drop: ((name: string) => void) | null
}

export function FunctionsView(): React.ReactElement {
  // Writes go through the SQL editor's route, so only its roles are offered them (RQ4).
  const sqlWrites = useSqlEditorOffered()
  const picker = useSchemaPicker()
  const { schema } = picker
  const [selected, setSelected] = useState<Row | null>(null)
  const { data: fns, loading, error, refetch } = useCatalogueRows("functions", schema)
  const draft = useSqlDraft(schema, refetch)
  const drop = (name: string): void => { draft.open(`DROP FUNCTION ${qualifiedName(schema, name)}();`) }
  const actions: FunctionRowActions = { select: setSelected, drop: sqlWrites ? drop : null }
  const template = `CREATE OR REPLACE FUNCTION ${quoteIdent(schema)}.my_function()\nRETURNS void\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- body\nEND;\n$$;`
  const create = <Button variant="primary" onClick={() => { draft.open(template) }}>Create function</Button>
  return (
    <div className="space-y-4">
      <PageHeader title="Functions" scope={<SchemaSelect picker={picker} />} action={sqlWrites ? create : null} />
      {error && <ErrorBanner message={error} />}
      <CatalogueTable
        list={{ rows: fns, loading, empty: { title: "No functions", description: `No functions found in schema "${schema}".` } }}
        head={<><Th>Name</Th><Th>Returns</Th><Th>Language</Th><Th /></>}
        row={(row, i) => <FunctionRow key={i} row={row} actions={actions} />}
      />
      <DefinitionPanel fn={selected} onClose={() => { setSelected(null) }} />
      <SqlDraftDialog draft={draft} />
    </div>
  )
}

function FunctionRow({ row, actions }: { row: Row; actions: FunctionRowActions }): React.ReactElement {
  const { drop } = actions
  return (
    <tr className={tableRowClass(true)} onClick={() => { actions.select(row) }}>
      <Td className="font-mono text-foreground">{cellText(row, "routine_name")}</Td>
      <Td className="text-xs text-muted-foreground">{cellText(row, "return_type")}</Td>
      <Td><Badge variant="blue">{cellTextOrNull(row, "language")?.toLowerCase()}</Badge></Td>
      <RowActions>{drop ? <DropRowButton onDrop={() => { drop(cellText(row, "routine_name")) }} /> : null}</RowActions>
    </tr>
  )
}

/** The selected function's definition, in a panel over the list. */
function DefinitionPanel({ fn, onClose }: { fn: Row | null; onClose: () => void }): React.ReactElement {
  return (
    <SlidePanel
      open={fn !== null}
      onClose={onClose}
      title={fn ? cellText(fn, "routine_name") : ""}
      subtitle={fn ? `${cellTextOrNull(fn, "language")?.toLowerCase()} · returns ${cellText(fn, "return_type")}` : undefined}
      width="max-w-[540px]"
    >
      {fn && <CodeBlock>{cellTextOrNull(fn, "routine_definition") ?? "(no definition)"}</CodeBlock>}
    </SlidePanel>
  )
}
