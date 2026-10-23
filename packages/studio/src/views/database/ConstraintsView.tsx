import React, { useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useSchemaPicker } from "../../hooks/useSchemaPicker.js"
import { Badge, CodeBlock, PageHeader, Td, Th, tableRowClass, type BadgeVariant } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { SlidePanel } from "../../components/SlidePanel.js"
import { SchemaSelect } from "../../components/database/SchemaSelect.js"
import { CatalogueTable, useCatalogueRows } from "../../components/database/CatalogueTable.js"
import { CONSTRAINT_KINDS, isOwned, useOwnedObjects } from "../../lib/owned-objects.js"
import { cellText } from "../metadata-row.js"

type Row = Record<string, unknown>

/**
 * Every constraint the database enforces, whether or not Supatype declared it.
 *
 * The model's Rules tab says what the schema asks for, in the author's words. This says what the
 * database will actually refuse, in Postgres's words, including constraints from tables Supatype
 * does not manage. When a bound stops behaving as the schema describes, the two disagreeing is the
 * fastest way to see it.
 *
 * `NOT NULL` is excluded: PG18 records it here as `contype = 'n'`, but it is a column property that
 * the table view already shows, and listing it once per nullable-less column drowns everything else.
 */
const TYPE_VARIANT: Record<string, BadgeVariant> = {
  "PRIMARY KEY": "indigo",
  "FOREIGN KEY": "blue",
  UNIQUE: "green",
  CHECK: "yellow",
}

/** Whether a push maintains the constraint, as the ownership ledger records it. */
type OwnedTest = (row: Row) => boolean

export function ConstraintsView(): React.ReactElement {
  const proxy = useProjectProxy()
  const picker = useSchemaPicker()
  const { schema } = picker
  const { owned, error: ownedError } = useOwnedObjects(proxy, schema)
  const [selected, setSelected] = useState<Row | null>(null)
  const { data: constraints, loading, error } = useCatalogueRows("constraints", schema)
  const isSupatype: OwnedTest = (row) => isOwned(owned, CONSTRAINT_KINDS[String(row["type"])] ?? [], row["table_name"], row["name"], row["comment"])
  return (
    <div className="space-y-4">
      <PageHeader title="Constraints" scope={<SchemaSelect picker={picker} />} />
      {error && <ErrorBanner message={error} />}
      {/* Without the ledger read every badge would be missing, which reads as "nothing is Supatype's". */}
      {ownedError && <ErrorBanner message={`Could not read which objects are Supatype's: ${ownedError}`} />}
      <CatalogueTable
        list={{ rows: constraints, loading, empty: { title: "No constraints", description: `No constraints found in schema "${schema}".` } }}
        head={<><Th>Name</Th><Th>Table</Th><Th>Type</Th><Th>Definition</Th></>}
        row={(row, i) => <ConstraintRow key={i} row={row} owned={isSupatype(row)} onSelect={setSelected} />}
      />
      <SlidePanel
        open={selected !== null}
        onClose={() => { setSelected(null) }}
        title={selected ? cellText(selected, "name") : ""}
        subtitle={selected ? `${cellText(selected, "type")} on ${cellText(selected, "table_name")}` : undefined}
        width="max-w-[540px]"
      >
        {selected && <CodeBlock>{cellText(selected, "definition")}</CodeBlock>}
      </SlidePanel>
    </div>
  )
}

function ConstraintRow({ row, owned, onSelect }: { row: Row; owned: boolean; onSelect: (row: Row) => void }): React.ReactElement {
  return (
    <tr className={tableRowClass(true)} onClick={() => { onSelect(row) }}>
      <Td className="font-mono">
        {cellText(row, "name")}
        {/* An unbadged constraint is one no push maintains: hand-written, or left behind by a schema
            that no longer declares it. */}
        {owned && <Badge variant="indigo" className="ml-2">supatype</Badge>}
      </Td>
      <Td className="text-muted-foreground text-xs font-mono">{cellText(row, "table_name")}</Td>
      <Td><Badge variant={TYPE_VARIANT[cellText(row, "type")] ?? "blue"}>{cellText(row, "type")}</Badge></Td>
      {/* Truncated: a check expression runs long, and the full text is one click away rather than
          pushing every other column off the screen. */}
      <Td className="text-xs font-mono text-muted-foreground max-w-md truncate">{cellText(row, "definition")}</Td>
    </tr>
  )
}
