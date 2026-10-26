import React, { useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useSchemaPicker } from "../../hooks/useSchemaPicker.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Badge, Card, CodeBlock, Td, Th } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { SlidePanel } from "../../components/SlidePanel.js"
import { CONSTRAINT_KINDS, isOwned, useOwnedObjects } from "../../lib/owned-objects.js"
import { cellText } from "../metadata-row.js"

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
const TYPE_VARIANT: Record<string, "indigo" | "blue" | "green" | "yellow"> = {
  "PRIMARY KEY": "indigo",
  "FOREIGN KEY": "blue",
  UNIQUE: "green",
  CHECK: "yellow",
}

export function ConstraintsView(): React.ReactElement {
  const proxy = useProjectProxy()
  const { schemas, schema, setSchema } = useSchemaPicker()
  const { owned, error: ownedError } = useOwnedObjects(proxy, schema)
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null)

  const { data: constraints, loading, error } = useApiQuery(
    () => proxy.metadata("constraints", { schema }).then((r) => r.rows),
    [proxy, schema],
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-foreground">Constraints</h1>
        <select
          value={schema}
          onChange={(e) => setSchema(e.target.value)}
          className="px-2 py-1 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none"
        >
          {(schemas.length > 0 ? schemas : [schema]).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {error && <ErrorBanner message={error} />}
      {/* Without the ledger read every badge would be missing, which reads as "nothing is Supatype's". */}
      {ownedError && <ErrorBanner message={`Could not read which objects are Supatype's: ${ownedError}`} />}

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />
          ))}
        </div>
      ) : constraints?.length === 0 ? (
        <EmptyState
          title="No constraints"
          description={`No constraints found in schema "${schema}".`}
        />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <Th className="px-4 py-2.5">Name</Th>
                  <Th className="px-4 py-2.5">Table</Th>
                  <Th className="px-4 py-2.5">Type</Th>
                  <Th className="px-4 py-2.5">Definition</Th>
                </tr>
              </thead>
              <tbody>
                {constraints?.map((row, i) => (
                  <tr
                    key={i}
                    className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                    onClick={() => setSelected(row)}
                  >
                    <Td className="px-4 py-3 font-mono">
                      {cellText(row, "name")}
                      {/* An unbadged constraint is one no push maintains: hand-written, or left
                          behind by a schema that no longer declares it. */}
                      {isOwned(owned, CONSTRAINT_KINDS[String(row["type"])] ?? [], row["table_name"], row["name"], row["comment"]) && (
                        <Badge variant="indigo" className="ml-2">
                          supatype
                        </Badge>
                      )}
                    </Td>
                    <Td className="px-4 py-3 text-muted-foreground text-xs font-mono">
                      {cellText(row, "table_name")}
                    </Td>
                    <Td className="px-4 py-3">
                      <Badge variant={TYPE_VARIANT[cellText(row, "type")] ?? "blue"}>
                        {cellText(row, "type")}
                      </Badge>
                    </Td>
                    {/* Truncated: a check expression runs long, and the full text is one click
                        away rather than pushing every other column off the screen. */}
                    <Td className="px-4 py-3 text-xs font-mono text-muted-foreground max-w-md truncate">
                      {cellText(row, "definition")}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <SlidePanel
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? cellText(selected, "name") : ""}
        subtitle={selected ? `${cellText(selected, "type")} on ${cellText(selected, "table_name")}` : undefined}
        width="max-w-[540px]"
      >
        {selected && <CodeBlock>{cellText(selected, "definition")}</CodeBlock>}
      </SlidePanel>
    </div>
  )
}
