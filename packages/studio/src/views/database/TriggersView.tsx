import React, { useState } from "react"
import { useSqlEditorOffered } from "../../hooks/useSqlEditorOffered.js"
import { useSchemaPicker } from "../../hooks/useSchemaPicker.js"
import { Badge, Button, CodeBlock, PageHeader, Td, Th, tableRowClass, type BadgeVariant } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { SlidePanel } from "../../components/SlidePanel.js"
import { SchemaSelect } from "../../components/database/SchemaSelect.js"
import { SqlDraftDialog, useSqlDraft } from "../../components/database/SqlDraftDialog.js"
import { CatalogueTable, DropRowButton, RowActions, useCatalogueRows } from "../../components/database/CatalogueTable.js"
import { qualifiedName, quoteIdent } from "../../lib/sql-identifier.js"
import { cellText } from "../metadata-row.js"

type Row = Record<string, unknown>

const EVENT_VARIANTS: Record<string, BadgeVariant> = { INSERT: "green", UPDATE: "yellow", DELETE: "red" }

const timingVariant = (t: string): BadgeVariant => t === "BEFORE" ? "yellow" : "blue"
const eventVariant = (e: string): BadgeVariant => EVENT_VARIANTS[e] ?? "blue"

/** What a row offers: open its statement, and (for the SQL editor's roles) drop it. */
interface TriggerRowActions {
  select: (row: Row) => void
  /** Drafts the drop for review; null for a role that may not write. */
  drop: ((row: Row) => void) | null
}

export function TriggersView(): React.ReactElement {
  // Writes go through the SQL editor's route, so only its roles are offered them (RQ4).
  const sqlWrites = useSqlEditorOffered()
  const picker = useSchemaPicker()
  const { schema } = picker
  const [selected, setSelected] = useState<Row | null>(null)
  const { data: triggers, loading, error, refetch } = useCatalogueRows("triggers", schema)
  const draft = useSqlDraft(schema, refetch)
  const drop = (row: Row): void => {
    draft.open(`DROP TRIGGER ${quoteIdent(cellText(row, "trigger_name"))} ON ${qualifiedName(schema, cellText(row, "event_object_table"))};`)
  }
  const actions: TriggerRowActions = { select: setSelected, drop: sqlWrites ? drop : null }
  const template = `CREATE OR REPLACE TRIGGER my_trigger\nBEFORE INSERT ON ${quoteIdent(schema)}.my_table\nFOR EACH ROW EXECUTE FUNCTION my_function();`
  const create = <Button variant="primary" onClick={() => { draft.open(template) }}>Create trigger</Button>
  return (
    <div className="space-y-4">
      <PageHeader title="Triggers" scope={<SchemaSelect picker={picker} />} action={sqlWrites ? create : null} />
      {error && <ErrorBanner message={error} />}
      <CatalogueTable
        list={{ rows: triggers, loading, empty: { title: "No triggers", description: `No triggers found in schema "${schema}".` } }}
        head={<><Th>Name</Th><Th>Table</Th><Th>Event</Th><Th>Orientation</Th><Th /></>}
        row={(row, i) => <TriggerRow key={i} row={row} actions={actions} />}
      />
      <StatementPanel trigger={selected} onClose={() => { setSelected(null) }} />
      <SqlDraftDialog draft={draft} />
    </div>
  )
}

function TriggerRow({ row, actions }: { row: Row; actions: TriggerRowActions }): React.ReactElement {
  const { drop } = actions
  return (
    <tr className={tableRowClass(true)} onClick={() => { actions.select(row) }}>
      <Td className="font-mono text-foreground">{cellText(row, "trigger_name")}</Td>
      <Td className="text-muted-foreground text-xs font-mono">{cellText(row, "event_object_table")}</Td>
      <Td>
        <span className="flex gap-1">
          <Badge variant={timingVariant(cellText(row, "action_timing"))}>{cellText(row, "action_timing")}</Badge>
          <Badge variant={eventVariant(cellText(row, "event_manipulation"))}>{cellText(row, "event_manipulation")}</Badge>
        </span>
      </Td>
      <Td className="text-xs text-muted-foreground">{cellText(row, "action_orientation")}</Td>
      <RowActions>{drop ? <DropRowButton onDrop={() => { drop(row) }} /> : null}</RowActions>
    </tr>
  )
}

/** The selected trigger's statement, in a panel over the list. */
function StatementPanel({ trigger, onClose }: { trigger: Row | null; onClose: () => void }): React.ReactElement {
  const on = trigger ? `${cellText(trigger, "action_timing")} ${cellText(trigger, "event_manipulation")} on ${cellText(trigger, "event_object_table")}` : undefined
  return (
    <SlidePanel open={trigger !== null} onClose={onClose} title={trigger ? cellText(trigger, "trigger_name") : ""} subtitle={on} width="max-w-[540px]">
      {trigger && <CodeBlock>{cellText(trigger, "action_statement")}</CodeBlock>}
    </SlidePanel>
  )
}
