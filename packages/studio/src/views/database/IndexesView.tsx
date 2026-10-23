import React, { useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useSchemaPicker } from "../../hooks/useSchemaPicker.js"
import { Badge, CodeBlock, PageHeader, Td, Th, tableRowClass } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { SlidePanel } from "../../components/SlidePanel.js"
import { SchemaSelect } from "../../components/database/SchemaSelect.js"
import { CatalogueTable, useCatalogueRows } from "../../components/database/CatalogueTable.js"
import { INDEX_KINDS, isOwned, useOwnedObjects } from "../../lib/owned-objects.js"
import { cellText, cellTextOrNull } from "../metadata-row.js"

type Row = Record<string, unknown>

/**
 * Every index the database holds, whether or not Supatype declared it.
 *
 * Distinct from a model's Rules tab, which lists what the *schema* declares. The difference between
 * the two is the interesting part: an index that a push failed to apply, or one added by hand in
 * psql, appears here and nowhere else. A uniqueness change that silently did not take was invisible
 * until you looked at exactly this.
 *
 * Read-only. Creating an index is a schema change and belongs in the schema, where the next push
 * will not drop it again.
 */
export function IndexesView(): React.ReactElement {
  const proxy = useProjectProxy()
  const picker = useSchemaPicker()
  const { schema } = picker
  const { owned, error: ownedError } = useOwnedObjects(proxy, schema)
  const [selected, setSelected] = useState<Row | null>(null)
  const { data: indexes, loading, error } = useCatalogueRows("indexes", schema)
  const isSupatype = (row: Row): boolean => isOwned(owned, INDEX_KINDS, row["table_name"], row["index_name"], row["comment"])
  return (
    <div className="space-y-4">
      <PageHeader title="Indexes" scope={<SchemaSelect picker={picker} />} />
      {error && <ErrorBanner message={error} />}
      {/* Without the ledger read every badge would be missing, which reads as "nothing is Supatype's". */}
      {ownedError && <ErrorBanner message={`Could not read which objects are Supatype's: ${ownedError}`} />}
      <CatalogueTable
        list={{ rows: indexes, loading, empty: { title: "No indexes", description: `No indexes found in schema "${schema}".` } }}
        head={<><Th>Name</Th><Th>Table</Th><Th>Columns</Th><Th>Type</Th><Th>Size</Th></>}
        row={(row, i) => <IndexRow key={i} row={row} owned={isSupatype(row)} onSelect={setSelected} />}
      />
      <SlidePanel
        open={selected !== null}
        onClose={() => { setSelected(null) }}
        title={selected ? cellText(selected, "index_name") : ""}
        subtitle={selected ? `on ${cellText(selected, "table_name")}` : undefined}
        width="max-w-[540px]"
      >
        {selected && <CodeBlock>{cellText(selected, "definition")}</CodeBlock>}
      </SlidePanel>
    </div>
  )
}

function IndexRow({ row, owned, onSelect }: { row: Row; owned: boolean; onSelect: (row: Row) => void }): React.ReactElement {
  return (
    <tr className={tableRowClass(true)} onClick={() => { onSelect(row) }}>
      <Td className="font-mono">
        {cellText(row, "index_name")}
        {/* Says who owns it. An index without this badge is one a push will not maintain and will
            not drop, which is worth knowing before editing it. */}
        {owned && <Badge variant="indigo" className="ml-2">supatype</Badge>}
      </Td>
      <Td className="text-muted-foreground text-xs font-mono">{cellText(row, "table_name")}</Td>
      <Td className="text-muted-foreground text-xs font-mono">{cellTextOrNull(row, "columns") ?? "-"}</Td>
      <Td>
        <span className="text-xs text-muted-foreground uppercase">{cellText(row, "method")}</span>
        {row["is_primary"] === true && <Badge variant="indigo" className="ml-2">PK</Badge>}
        {row["is_unique"] === true && row["is_primary"] !== true && <Badge variant="green" className="ml-2">unique</Badge>}
      </Td>
      <Td className="text-xs text-muted-foreground">{cellText(row, "size")}</Td>
    </tr>
  )
}
