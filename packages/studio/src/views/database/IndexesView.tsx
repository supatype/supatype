import React, { useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useSchemaPicker } from "../../hooks/useSchemaPicker.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Badge, Card, CodeBlock, Td, Th } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { SlidePanel } from "../../components/SlidePanel.js"
import { isManaged } from "../../lib/managed-comment.js"

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
const LIST_QUERY = (schema: string): string => `
  SELECT t.relname AS table_name, i.relname AS index_name, am.amname AS method,
         ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
         pg_size_pretty(pg_relation_size(ix.indexrelid)) AS size,
         (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
            FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS columns,
         pg_get_indexdef(ix.indexrelid) AS definition,
         obj_description(i.oid, 'pg_class') AS comment
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_am am ON am.oid = i.relam
  WHERE n.nspname = '${schema}'
  ORDER BY t.relname, i.relname
`

export function IndexesView(): React.ReactElement {
  const proxy = useProjectProxy()
  const { schemas, schema, setSchema } = useSchemaPicker()
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null)

  const { data: indexes, loading, error } = useApiQuery(
    () => proxy.sql(LIST_QUERY(schema)).then((r) => r.rows),
    [proxy, schema],
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-foreground">Indexes</h1>
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

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />
          ))}
        </div>
      ) : indexes?.length === 0 ? (
        <EmptyState title="No indexes" description={`No indexes found in schema "${schema}".`} />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <Th className="px-4 py-2.5">Name</Th>
                  <Th className="px-4 py-2.5">Table</Th>
                  <Th className="px-4 py-2.5">Columns</Th>
                  <Th className="px-4 py-2.5">Type</Th>
                  <Th className="px-4 py-2.5">Size</Th>
                </tr>
              </thead>
              <tbody>
                {indexes?.map((row, i) => (
                  <tr
                    key={i}
                    className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                    onClick={() => setSelected(row)}
                  >
                    <Td className="px-4 py-3 font-mono">
                      {row["index_name"] as string}
                      {/* Says who owns it. An index without this badge is one a push will not
                          maintain and will not drop, which is worth knowing before editing it. */}
                      {isManaged(row["comment"]) && (
                        <Badge variant="indigo" className="ml-2">
                          supatype
                        </Badge>
                      )}
                    </Td>
                    <Td className="px-4 py-3 text-muted-foreground text-xs font-mono">
                      {row["table_name"] as string}
                    </Td>
                    <Td className="px-4 py-3 text-muted-foreground text-xs font-mono">
                      {(row["columns"] as string) ?? "-"}
                    </Td>
                    <Td className="px-4 py-3">
                      <span className="text-xs text-muted-foreground uppercase">
                        {row["method"] as string}
                      </span>
                      {row["is_primary"] === true && (
                        <Badge variant="indigo" className="ml-2">
                          PK
                        </Badge>
                      )}
                      {row["is_unique"] === true && row["is_primary"] !== true && (
                        <Badge variant="green" className="ml-2">
                          unique
                        </Badge>
                      )}
                    </Td>
                    <Td className="px-4 py-3 text-xs text-muted-foreground">
                      {row["size"] as string}
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
        title={(selected?.["index_name"] as string) ?? ""}
        subtitle={selected ? `on ${selected["table_name"] as string}` : undefined}
        width="max-w-[540px]"
      >
        {selected && <CodeBlock>{(selected["definition"] as string) ?? ""}</CodeBlock>}
      </SlidePanel>
    </div>
  )
}
